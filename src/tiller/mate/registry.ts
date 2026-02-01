import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PATHS } from "../state/config.js";
import type { Mate, MateRegistry } from "./types.js";
import { MATE_ENV } from "./types.js";

// Claude agents directory (session dirs live here) - derived from PROJECT_ROOT
const CLAUDE_AGENTS_DIR = join(PATHS.PROJECT_ROOT, ".claude", "agents");

// Session is stale if not modified in this many minutes
const SESSION_STALE_MINUTES = 60;

// Per-agent files live here (derived from PATHS)
const MATES_DIR = PATHS.MATES_DIR;

// Legacy single-file registry (for migration)
const LEGACY_REGISTRY_FILE = join(PATHS.TILLER_DIR, "mates.json");

/**
 * Ensure mates directory exists
 */
function ensureMatesDir(): void {
	if (!existsSync(MATES_DIR)) {
		mkdirSync(MATES_DIR, { recursive: true });
	}
}

/**
 * Migrate from legacy mates.json to per-agent files
 * Runs once, then renames old file to mates.json.migrated
 */
function migrateIfNeeded(): void {
	if (!existsSync(LEGACY_REGISTRY_FILE)) return;

	ensureMatesDir();

	try {
		const legacy: MateRegistry = JSON.parse(
			readFileSync(LEGACY_REGISTRY_FILE, "utf-8"),
		);

		// Write each mate to its own file
		for (const mate of Object.values(legacy.mates)) {
			const filePath = join(MATES_DIR, `${mate.name}.json`);
			writeFileSync(filePath, JSON.stringify(mate, null, 2));
		}

		// Rename old file to mark migration complete
		renameSync(LEGACY_REGISTRY_FILE, `${LEGACY_REGISTRY_FILE}.migrated`);
	} catch (err) {
		// Migration failed - leave old file in place for retry
		console.error("Migration failed:", err);
	}
}

/**
 * Load a single mate by name
 */
function loadMate(name: string): Mate | null {
	migrateIfNeeded();
	const filePath = join(MATES_DIR, `${name}.json`);
	if (!existsSync(filePath)) return null;
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

/**
 * Save a single mate to its own file
 */
function saveMate(mate: Mate): void {
	ensureMatesDir();
	const filePath = join(MATES_DIR, `${mate.name}.json`);
	writeFileSync(filePath, JSON.stringify(mate, null, 2));
}

/**
 * Delete a mate's file
 */
function deleteMateFile(name: string): void {
	const filePath = join(MATES_DIR, `${name}.json`);
	if (existsSync(filePath)) {
		unlinkSync(filePath);
	}
}

/**
 * Acquire a lock for a mate file (simple file-based lock)
 * Returns lock file path if acquired, null if lock exists (concurrent access)
 */
function acquireLock(name: string, timeoutMs = 5000): string | null {
	const lockPath = join(MATES_DIR, `${name}.lock`);
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		if (!existsSync(lockPath)) {
			try {
				// Create lock file with our PID
				writeFileSync(lockPath, String(process.pid), { flag: "wx" }); // wx = exclusive create
				return lockPath;
			} catch {
				// Another process beat us - retry
			}
		}
		// Check if lock holder is dead
		try {
			const lockerPid = Number.parseInt(
				readFileSync(lockPath, "utf-8").trim(),
				10,
			);
			if (lockerPid && !isPidAlive(lockerPid)) {
				unlinkSync(lockPath); // Dead process - clean up
				continue;
			}
		} catch {
			// Can't read lock - retry
		}
		// Wait a bit before retry
		const waitMs = 10 + Math.random() * 20;
		const wait = Date.now() + waitMs;
		while (Date.now() < wait) {
			/* busy wait */
		}
	}

	return null; // Timeout
}

/**
 * Release a lock
 */
function releaseLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {
		// Lock already gone
	}
}

export function addMate(name: string): Mate {
	migrateIfNeeded();
	const existing = loadMate(name);
	if (existing) {
		throw new Error(`Mate already exists: ${name}`);
	}
	const mate: Mate = {
		name,
		state: "available",
		assignedPlan: null,
		claimedBy: null,
		claimedBySession: null,
		claimedAt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	saveMate(mate);
	return mate;
}

export function getMate(name: string): Mate | null {
	migrateIfNeeded();
	return loadMate(name);
}

export function updateMate(name: string, updates: Partial<Mate>): Mate {
	// Acquire lock to prevent concurrent modifications
	const lockPath = acquireLock(name);
	if (!lockPath) {
		throw new Error(`Cannot acquire lock for mate: ${name} (concurrent access)`);
	}

	try {
		const mate = loadMate(name);
		if (!mate) {
			throw new Error(`Mate not found: ${name}`);
		}
		const updated: Mate = {
			...mate,
			...updates,
			updatedAt: new Date().toISOString(),
		};
		saveMate(updated);
		return updated;
	} finally {
		releaseLock(lockPath);
	}
}

export function listMates(): Mate[] {
	migrateIfNeeded();
	ensureMatesDir();

	const files = readdirSync(MATES_DIR).filter((f) => f.endsWith(".json"));
	const mates: Mate[] = [];

	for (const file of files) {
		try {
			const content = readFileSync(join(MATES_DIR, file), "utf-8");
			mates.push(JSON.parse(content));
		} catch (e) {
			if (process.env.TILLER_DEBUG) {
				console.error(
					`[tiller mate] Skipping invalid mate file ${file}: ${(e as Error).message}`,
				);
			}
		}
	}

	return mates;
}

export function removeMate(name: string): void {
	const mate = loadMate(name);
	if (!mate) {
		throw new Error(`Mate not found: ${name}`);
	}
	if (mate.state === "claimed" || mate.state === "sailing") {
		throw new Error(`Cannot remove ${mate.state} mate: ${name}`);
	}
	deleteMateFile(name);
}

/**
 * Get current Claude session ID from TILLER_SESSION env var
 * Set by Claude Code hook or explicitly by user
 */
export function getCurrentSession(): string | null {
	return process.env[MATE_ENV.TILLER_SESSION] || null;
}

/**
 * Find mate claimed by session ID
 */
export function getMateBySession(sessionId: string): Mate | null {
	const mates = listMates();
	return (
		mates.find(
			(m) => m.claimedBySession === sessionId && m.state !== "available",
		) || null
	);
}

/**
 * Check if a PID is still alive
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // Signal 0 = check existence
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if a session is stale (dir doesn't exist or not modified recently)
 */
export function isSessionStale(sessionId: string): boolean {
	const sessionDir = join(CLAUDE_AGENTS_DIR, sessionId);

	if (!existsSync(sessionDir)) {
		return true; // Session dir doesn't exist = stale
	}

	try {
		const stat = statSync(sessionDir);
		const mtime = stat.mtime.getTime();
		const now = Date.now();
		const ageMinutes = (now - mtime) / (1000 * 60);
		return ageMinutes > SESSION_STALE_MINUTES;
	} catch {
		return true; // Can't stat = assume stale
	}
}

/**
 * Check if a mate is stale (PID dead OR session stale)
 */
export function isMateStale(mate: Mate): boolean {
	if (mate.state === "available") return false;

	// Check PID first (fast)
	if (mate.claimedBy && !isPidAlive(mate.claimedBy)) {
		return true;
	}

	// Check session freshness
	if (mate.claimedBySession && isSessionStale(mate.claimedBySession)) {
		return true;
	}

	return false;
}

/**
 * Release a stale mate back to available state
 */
export function releaseMate(name: string): void {
	updateMate(name, {
		state: "available",
		claimedBy: null,
		claimedBySession: null,
		claimedAt: null,
	});
}

/**
 * Garbage collect stale mates
 * Returns list of released mate names
 */
export function gcStaleMates(): string[] {
	const released: string[] = [];
	const mates = listMates();

	for (const mate of mates) {
		if (isMateStale(mate)) {
			releaseMate(mate.name);
			released.push(mate.name);
		}
	}

	return released;
}
