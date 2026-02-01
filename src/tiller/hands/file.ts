/**
 * Hand File Management
 *
 * Manages `.tiller/hands/<name>.json` files for multi-agent coordination.
 * Each hand file represents a worker slot that can be locked by a process.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PATHS } from "../state/config.js";
import { handName, randomHandName } from "./names.js";

// Derived from PATHS (cwd-independent)
const HANDS_DIR = PATHS.HANDS_DIR;

/**
 * Hand file state - matches file-based lifecycle
 */
export type HandFileState = "reserved" | "running" | "idle" | "stopped";

/**
 * Hand file structure - stored as JSON in .tiller/hands/<name>.json
 */
export interface HandFile {
	/** Hand name (e.g., "casey-stone") */
	name: string;

	/** Current state */
	state: HandFileState;

	/** Run this hand is bound to */
	run_id: string;

	/** ISO timestamp when hand was reserved */
	reserved_at: string;

	/** ISO timestamp when lock was acquired (null if not locked) */
	locked_at: string | null;

	/** PID of process holding the lock (null if not locked) */
	locked_by_pid: number | null;
}

/**
 * Ensure .tiller/hands/ directory exists
 */
export function ensureHandsDir(): void {
	if (!existsSync(HANDS_DIR)) {
		mkdirSync(HANDS_DIR, { recursive: true });
	}
}

/**
 * Get the file path for a hand
 */
function handFilePath(name: string): string {
	return join(HANDS_DIR, `${name}.json`);
}

/**
 * Check if a process is alive
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write hand file atomically (write to .tmp, then rename)
 */
function writeHandFileAtomic(name: string, data: HandFile): void {
	const filePath = handFilePath(name);
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2));
	renameSync(tmpPath, filePath);
}

/**
 * Reserve a new hand slot
 *
 * @param runId - Run to bind the hand to
 * @param sessionId - Optional session ID for deterministic naming
 * @returns The created HandFile
 * @throws If a hand with the generated name already exists
 */
export function reserveHand(runId: string, sessionId?: string): HandFile {
	ensureHandsDir();

	// Generate name - deterministic if sessionId provided, random otherwise
	const name = sessionId ? handName(runId, sessionId) : randomHandName();
	const filePath = handFilePath(name);

	// Check for collision (unlikely with 1024+ names)
	if (existsSync(filePath)) {
		throw new Error(`Hand name collision: ${name} already exists`);
	}

	const now = new Date().toISOString();
	const handFile: HandFile = {
		name,
		state: "reserved",
		run_id: runId,
		reserved_at: now,
		locked_at: null,
		locked_by_pid: null,
	};

	writeHandFileAtomic(name, handFile);
	return handFile;
}

/**
 * List all hands in .tiller/hands/
 *
 * @returns Array of HandFile objects
 */
export function listHands(): HandFile[] {
	ensureHandsDir();

	const files = readdirSync(HANDS_DIR).filter((f) => f.endsWith(".json"));
	const hands: HandFile[] = [];

	for (const file of files) {
		const filePath = join(HANDS_DIR, file);
		try {
			const content = readFileSync(filePath, "utf-8");
			const hand = JSON.parse(content) as HandFile;
			hands.push(hand);
		} catch {
			// Skip invalid files
		}
	}

	return hands;
}

/**
 * Load a single hand file
 *
 * @param name - Hand name
 * @returns HandFile if found, null otherwise
 */
export function loadHand(name: string): HandFile | null {
	const filePath = handFilePath(name);

	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		return JSON.parse(content) as HandFile;
	} catch {
		return null;
	}
}

/**
 * Acquire exclusive lock on a hand
 *
 * @param name - Hand name
 * @param pid - Process ID to lock with
 * @returns true if lock acquired, false otherwise
 */
export function lockHand(name: string, pid: number): boolean {
	const hand = loadHand(name);

	if (!hand) {
		return false;
	}

	// Can only lock reserved or idle hands
	if (hand.state !== "reserved" && hand.state !== "idle") {
		return false;
	}

	// Check if already locked by a live process
	if (hand.locked_by_pid !== null && isProcessAlive(hand.locked_by_pid)) {
		return false;
	}

	// Acquire lock
	const now = new Date().toISOString();
	const updated: HandFile = {
		...hand,
		state: "running",
		locked_at: now,
		locked_by_pid: pid,
	};

	writeHandFileAtomic(name, updated);
	return true;
}

/**
 * Release lock on a hand
 *
 * @param name - Hand name
 */
export function unlockHand(name: string): void {
	const hand = loadHand(name);

	if (!hand) {
		return;
	}

	const updated: HandFile = {
		...hand,
		state: "idle",
		locked_at: null,
		locked_by_pid: null,
	};

	writeHandFileAtomic(name, updated);
}

/**
 * Update hand state
 *
 * @param name - Hand name
 * @param state - New state
 */
export function updateHandFileState(name: string, state: HandFileState): void {
	const hand = loadHand(name);

	if (!hand) {
		return;
	}

	const updated: HandFile = {
		...hand,
		state,
	};

	writeHandFileAtomic(name, updated);
}

/**
 * Kill (remove) a hand
 *
 * @param name - Hand name
 * @returns true if killed, false if running process prevents kill
 */
export function killHand(name: string): boolean {
	const hand = loadHand(name);

	if (!hand) {
		return false;
	}

	// Cannot kill if process is still running
	if (
		hand.state === "running" &&
		hand.locked_by_pid !== null &&
		isProcessAlive(hand.locked_by_pid)
	) {
		return false;
	}

	const filePath = handFilePath(name);
	try {
		unlinkSync(filePath);
		return true;
	} catch {
		return false;
	}
}

// Export directory constant for testing
export { HANDS_DIR };
