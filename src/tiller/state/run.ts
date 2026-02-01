/**
 * Run state management
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	ReadyRun,
	Run,
	RunState,
	Transition,
} from "../types/index.js";
import {
	canTransition,
	isRunState,
	matchState,
	VALID_TRANSITIONS,
} from "../types/index.js";
import { normalizePlanRef, parseInitiativeRef } from "../utils/ref.js";
import { ensureTillerDir, PATHS } from "./config.js";
import { logEvent } from "./events.js";
import { getWorkingInitiative } from "./initiative.js";
import { normalizePlanPath } from "./paths.js";

const { RUNS_DIR, LEGACY_TRACKS_DIR } = PATHS;

/**
 * Migrate old flat state to HSM state
 */
function migrateRunState(state: string): RunState {
	const migration: Record<string, RunState> = {
		active: "active/executing",
		paused: "active/paused",
		checkpoint: "active/checkpoint",
		verifying: "verifying/testing",
	};
	return (migration[state] ?? state) as RunState;
}

/**
 * Ensure run has all multi-run fields (migration helper)
 */
function ensureRunDefaults(track: Partial<Run>): Run {
	return {
		id: track.id ?? generateRunId(),
		initiative: track.initiative ?? null,
		intent: track.intent ?? "",
		state: migrateRunState(track.state ?? "proposed"),
		plan_path: track.plan_path ?? "",
		created: track.created ?? new Date().toISOString(),
		updated: track.updated ?? new Date().toISOString(),
		transitions: track.transitions ?? [],
		checkpoints: track.checkpoints ?? [],
		beads_epic_id: track.beads_epic_id ?? null,
		beads_task_id: track.beads_task_id ?? null,
		beads_snapshot: track.beads_snapshot ?? null,
		claimed_by: track.claimed_by ?? null,
		claimed_at: track.claimed_at ?? null,
		claim_expires: track.claim_expires ?? null,
		files_touched: track.files_touched ?? [],
		priority: track.priority ?? 99,
		depends_on: track.depends_on ?? [],
		verification: track.verification,
	};
}

/**
 * Generate unique run ID (e.g., "run-a1b2c3")
 * IDs are immutable - plan_ref is derived from plan_path at read-time.
 */
export function generateRunId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "run-";
	for (let i = 0; i < 6; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

/**
 * Find existing run by plan_path (idempotency check)
 *
 * Normalizes paths before comparing to handle both absolute and relative formats.
 */
export function getRunByPlanPath(planPath: string): Run | null {
	const runs = listRuns();
	const normalizedInput = normalizePlanPath(planPath);
	return runs.find((r) => normalizePlanPath(r.plan_path) === normalizedInput) ?? null;
}

/**
 * Create a new run with default values
 *
 * IDEMPOTENT: Returns existing run if one already exists for this plan_path.
 * This prevents duplicate runs from being created by parallel sessions,
 * hooks, or repeated init/sync operations.
 *
 * @param planPath - Path to the PLAN.md file
 * @param intent - Description of what the track accomplishes
 * @param initialState - Starting state (default: "proposed", use "ready" for ad-hoc plans)
 */
export function createRun(
	planPath: string,
	intent: string,
	initialState: RunState = "proposed",
): Run {
	ensureTillerDir();

	// Idempotency: return existing run if one exists for this plan
	const existing = getRunByPlanPath(planPath);
	if (existing) {
		return existing;
	}

	const now = new Date().toISOString();
	const track: Run = {
		id: generateRunId(),
		initiative: null, // Set by init command using parseInitiativeFromPath
		intent,
		state: initialState,
		plan_path: planPath,
		created: now,
		updated: now,
		transitions: [],
		checkpoints: [],
		beads_epic_id: null,
		beads_task_id: null,
		beads_snapshot: null,

		// Multi-track defaults
		claimed_by: null,
		claimed_at: null,
		claim_expires: null,
		files_touched: [],
		priority: 99,
		depends_on: [],
	};

	saveRun(track);
	logEvent({ event: "track_created", track: track.id, plan: planPath });

	return track;
}

// ============================================
// Versioned read/write (08-10: monotonic versioned state)
// mtime as OPTIMISTIC LOCK TOKEN - filesystem granularity dependent
// ============================================

/** Error thrown when file changes during read (staleness detected) */
export class StaleReadError extends Error {
	constructor(
		public readonly runId: string,
		public readonly expectedVersion: string,
		public readonly actualVersion: string,
	) {
		super(
			`State may be stale (mtime changed during read): expected ${expectedVersion}, got ${actualVersion}. ` +
				`Caveat: mtime granularity is filesystem-dependent (~1s on HFS+/FAT32).`,
		);
		this.name = "StaleReadError";
	}
}

/** Error thrown when attempting to save with stale version */
export class StaleWriteError extends Error {
	constructor(
		public readonly runId: string,
		public readonly expectedVersion: string,
		public readonly actualVersion: string,
	) {
		super(
			`Refusing write: version mismatch (expected ${expectedVersion}, found ${actualVersion}). ` +
				`Another process may have modified the file.`,
		);
		this.name = "StaleWriteError";
	}
}

/** Get file mtime as ISO string (version token) */
function getFileMtime(filePath: string): string | null {
	try {
		const stats = statSync(filePath);
		return stats.mtime.toISOString();
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(
				`[run] Failed to get mtime for ${filePath}: ${(e as Error).message}`,
			);
		}
		return null;
	}
}

/**
 * Load run by ID with version metadata (08-10).
 * Populates _version (mtime) and _read_at fields.
 *
 * IMPORTANT: mtime is an OPTIMISTIC LOCK TOKEN, not truth.
 * Filesystem granularity varies (ext4: ns, HFS+: 1s, FAT32: 2s).
 * Two writes within same granularity window are indistinguishable.
 *
 * @throws StaleReadError if file mtime changes during read
 */
export function loadRunVersioned(runId: string): Run | null {
	const path = join(RUNS_DIR, `${runId}.json`);
	if (!existsSync(path)) {
		return null;
	}

	try {
		// Get mtime BEFORE read
		const mtimeBefore = getFileMtime(path);
		if (!mtimeBefore) return null;

		const readAt = new Date().toISOString();
		const content = readFileSync(path, "utf-8");
		const track = JSON.parse(content) as Run;

		// Get mtime AFTER read - detect concurrent modification
		const mtimeAfter = getFileMtime(path);
		if (mtimeAfter !== mtimeBefore) {
			throw new StaleReadError(runId, mtimeBefore, mtimeAfter ?? "unknown");
		}

		// Ensure multi-track fields exist (migration from older format)
		const fullTrack = ensureRunDefaults(track);

		// Attach version metadata (not persisted)
		fullTrack._version = mtimeBefore;
		fullTrack._read_at = readAt;

		return fullTrack;
	} catch (e) {
		if (e instanceof StaleReadError) throw e;
		return null;
	}
}

/**
 * Load run by ID (backward compatible - no version metadata)
 */
export function loadRun(runId: string): Run | null {
	const path = join(RUNS_DIR, `${runId}.json`);
	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = readFileSync(path, "utf-8");
		const track = JSON.parse(content) as Run;

		// Ensure multi-track fields exist (migration from older format)
		return ensureRunDefaults(track);
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(
				`[run] Failed to load run ${runId}: ${(e as Error).message}`,
			);
		}
		return null;
	}
}

/**
 * Strip version metadata before saving (these are derived, not persisted)
 */
function stripVersionMetadata(track: Run): Omit<Run, "_version" | "_read_at"> {
	const { _version, _read_at, ...rest } = track;
	return rest;
}

/**
 * Save track to disk (strips version metadata - these are derived, not persisted)
 */
export function saveRun(track: Run): void {
	ensureTillerDir();
	const path = join(RUNS_DIR, `${track.id}.json`);
	const cleanTrack = stripVersionMetadata(track);
	writeFileSync(path, JSON.stringify(cleanTrack, null, 2));
}

/**
 * Delete a run from disk
 * @returns true if deleted, false if didn't exist
 */
export function deleteRun(runId: string): boolean {
	const path = join(RUNS_DIR, `${runId}.json`);
	if (!existsSync(path)) {
		return false;
	}
	unlinkSync(path);
	logEvent({
		event: "run_deleted",
		track: runId,
		reason: "repair_orphan",
	});
	return true;
}

/**
 * Save track only if version matches (optimistic locking).
 * Prevents lost updates when multiple agents work concurrently.
 *
 * IMPORTANT: mtime is an OPTIMISTIC LOCK TOKEN, not truth.
 * Filesystem granularity varies - two writes in same window are indistinguishable.
 *
 * @param track - Run to save (must have _version from loadRunVersioned)
 * @returns { saved: true, newVersion } on success
 * @throws StaleWriteError if version mismatch (file was modified since read)
 * @throws Error if track has no _version (wasn't loaded with loadRunVersioned)
 */
export function saveRunIfFresh(track: Run): { saved: true; newVersion: string } {
	if (!track._version) {
		throw new Error(
			"Cannot use saveRunIfFresh without version. Use loadRunVersioned() first.",
		);
	}

	const path = join(RUNS_DIR, `${track.id}.json`);
	const currentVersion = getFileMtime(path);

	if (currentVersion !== track._version) {
		throw new StaleWriteError(
			track.id,
			track._version,
			currentVersion ?? "file deleted",
		);
	}

	// Version matches - safe to write
	saveRun(track);

	// Get new version after write
	const newVersion = getFileMtime(path) ?? new Date().toISOString();
	return { saved: true, newVersion };
}

/**
 * Filter options for listRuns
 */
export interface ListRunsOptions {
	stateQuery?: string;
	initiative?: string;
}

/**
 * List all tracks, optionally filtered by state query and/or initiative
 * Supports HSM queries: "active" matches active/*, "verifying/failed" matches exact
 *
 * @param options - Filter options (stateQuery, initiative)
 * @returns Filtered tracks sorted by updated timestamp (newest first)
 */
export function listRuns(options?: string | ListRunsOptions): Run[] {
	ensureTillerDir();

	if (!existsSync(RUNS_DIR)) {
		return [];
	}

	// Support legacy string parameter (stateQuery only)
	const opts: ListRunsOptions =
		typeof options === "string" ? { stateQuery: options } : (options ?? {});

	const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	const tracks: Run[] = [];

	for (const file of files) {
		try {
			const content = readFileSync(join(RUNS_DIR, file), "utf-8");
			const track = JSON.parse(content) as Partial<Run>;
			const fullTrack = ensureRunDefaults(track);

			// Filter by state query
			if (opts.stateQuery && !matchState(fullTrack.state, opts.stateQuery)) {
				continue;
			}

			// Filter by initiative
			if (
				opts.initiative !== undefined &&
				fullTrack.initiative !== opts.initiative
			) {
				continue;
			}

			tracks.push(fullTrack);
		} catch (e) {
			// Skip invalid files but log in debug mode
			if (process.env.TILLER_DEBUG) {
				console.error(
					`[run] Skipping invalid run file ${file}: ${(e as Error).message}`,
				);
			}
		}
	}

	return tracks.sort((a, b) => b.updated.localeCompare(a.updated));
}

/**
 * Validate state transition
 */
export function isValidTransition(from: RunState, to: RunState): boolean {
	return canTransition(from, to);
}

/**
 * Apply state transition (validates + updates track)
 */
export function applyTransition(
	track: Run,
	toState: RunState,
	by: "human" | "agent" = "human",
	reason?: string,
): { success: boolean; track?: Run; error?: string } {
	if (!canTransition(track.state, toState)) {
		const valid = VALID_TRANSITIONS[track.state];
		return {
			success: false,
			error: `Cannot transition from '${track.state}' to '${toState}'. Valid: ${valid.join(", ") || "none"}`,
		};
	}

	// ADR-0004 invariant: run states require entry via active/executing
	const planStates: RunState[] = ["proposed", "approved", "ready"];
	if (
		planStates.includes(track.state) &&
		isRunState(toState) &&
		toState !== "active/executing"
	) {
		return {
			success: false,
			error: `Cannot transition directly to '${toState}' from plan state; start with 'active/executing'`,
		};
	}

	const transition: Transition = {
		from: track.state,
		to: toState,
		at: new Date().toISOString(),
		by,
		...(reason && { reason }),
	};

	track.transitions.push(transition);
	track.state = toState;
	track.updated = transition.at;

	saveRun(track);
	logEvent({
		event: "state_change",
		track: track.id,
		from: transition.from,
		to: transition.to,
	});

	return { success: true, track };
}

/**
 * Find active track (any active/* substate)
 */
export function findActiveRun(): Run | null {
	const tracks = listRuns("active");
	return tracks[0] ?? null;
}

/**
 * Get default track by priority: active > verifying > approved > proposed
 * Uses HSM parent-level matching
 */
export function getDefaultRun(): Run | null {
	// Priority order for HSM states (parent-level queries)
	const priorities = ["active", "verifying", "ready", "approved", "proposed"];

	for (const stateQuery of priorities) {
		const tracks = listRuns(stateQuery);
		if (tracks.length > 0) {
			return tracks[0];
		}
	}

	return null;
}

// ============================================
// Multi-track: Claiming helpers
// ============================================

/**
 * Check if a track's claim has expired
 */
export function isClaimExpired(track: Run): boolean {
	if (!track.claim_expires) return true;
	return new Date(track.claim_expires) < new Date();
}

/**
 * Check if a track is available for claiming
 * Available if: unclaimed OR claim has expired
 */
export function isRunAvailable(track: Run): boolean {
	return !track.claimed_by || isClaimExpired(track);
}

/**
 * Claim a run for an agent
 */
export function claimRun(
	track: Run,
	agentId: string,
	ttlMinutes: number = 30,
): { success: boolean; track?: Run; error?: string } {
	if (track.claimed_by && !isClaimExpired(track)) {
		return {
			success: false,
			error: `Run already claimed by ${track.claimed_by}`,
		};
	}

	const now = new Date();
	const expiry = new Date(now.getTime() + ttlMinutes * 60 * 1000);

	track.claimed_by = agentId;
	track.claimed_at = now.toISOString();
	track.claim_expires = expiry.toISOString();
	track.updated = now.toISOString();

	saveRun(track);
	logEvent({ event: "track_claimed", track: track.id, agent: agentId });

	return { success: true, track };
}

/**
 * Release a track's claim
 */
export function releaseRun(track: Run): Run {
	track.claimed_by = null;
	track.claimed_at = null;
	track.claim_expires = null;
	track.updated = new Date().toISOString();

	saveRun(track);
	logEvent({ event: "track_released", track: track.id });

	return track;
}

// ============================================
// Multi-track: Conflict detection
// ============================================

/**
 * Detect file conflicts between a track and other active tracks
 * Returns IDs of tracks with overlapping files_touched
 */
export function detectFileConflicts(
	track: Run,
	activeTracks: Run[],
): string[] {
	if (track.files_touched.length === 0) return [];

	return activeTracks
		.filter((t) => t.id !== track.id && matchState(t.state, "active"))
		.filter((t) => t.files_touched.some((f) => track.files_touched.includes(f)))
		.map((t) => t.id);
}

/**
 * Get ready tracks - ready/active, unclaimed, unblocked
 */
export function getReadyRuns(): ReadyRun[] {
	const allTracks = listRuns();
	const activeTracks = allTracks.filter((t) => matchState(t.state, "active"));

	const ready = allTracks.filter((t) => {
		// Must be ready or active/* (not verifying/complete/abandoned/proposed/approved)
		const isReady = t.state === "ready" || matchState(t.state, "active");
		if (!isReady) return false;

		// Must not be claimed (or claim expired)
		if (t.claimed_by && !isClaimExpired(t)) return false;

		// Must not be blocked by dependencies
		if (t.depends_on?.length) {
			const blockers = t.depends_on.filter((depId) => {
				const dep = allTracks.find((x) => x.id === depId);
				return dep && dep.state !== "complete";
			});
			if (blockers.length > 0) return false;
		}

		return true;
	});

	// Add conflict info and sort by priority
	return ready
		.map((t) => ({
			...t,
			conflicts_with: detectFileConflicts(t, activeTracks),
			can_claim: true,
		}))
		.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
}

/**
 * Garbage collect stale claims
 */
export function gcStaleClaims(): Run[] {
	const tracks = listRuns();
	const released: Run[] = [];

	for (const track of tracks) {
		if (track.claimed_by && isClaimExpired(track)) {
			releaseRun(track);
			released.push(track);
		}
	}

	return released;
}

// ============================================
// Plan Reference Support (UX: plan refs as primary identifier)
// ============================================

/**
 * Parse plan reference from plan_path
 * Examples:
 *   ".planning/phases/02-tiller-cli-core/02-01-PLAN.md" → "02-01"
 *   ".planning/phases/02.1-workflow-engine/02.1-05-PLAN.md" → "02.1-05"
 *   ".planning/phases/06/06.3-01-PLAN.md" → "06.3-01"
 */
export function parsePlanRef(planPath: string): string | null {
	if (!planPath) return null;

	// Extract filename from path
	const filename = planPath.split("/").pop() ?? "";

	// Match pattern: digits/dots + hyphen + digits before optional suffix + -PLAN.md or -PLAN.skip.md
	// e.g., "02-01-PLAN.md" → "02-01"
	//       "02.1-05-PLAN.md" → "02.1-05"
	//       "03.1-03-FIX-PLAN.md" → "03.1-03"
	//       "01-01-PLAN.skip.md" → "01-01" (abandoned plan)
	const match = filename.match(/^([\d.]+(?:-[\d.]+)?)(?:-[A-Z]+)?-PLAN(?:\.skip)?\.md$/i);
	return match ? match[1] : null;
}

/**
 * Get plan reference for a track (derived from plan_path)
 */
export function getRunPlanRef(track: Run): string {
	return parsePlanRef(track.plan_path) ?? track.id;
}

/**
 * Resolve a track reference (accepts plan ref like "02-01" OR track ID like "track-abc123")
 * Returns null if not found
 *
 * 01-10: Initiative-scoped resolution - current initiative first, then global fallback
 * If current initiative has the plan FILE but no run, returns null (no cross-initiative fallback)
 */
export function resolveRunRef(ref: string): Run | null {
	// Parse initiative:ref syntax (e.g., "dogfooding:01-19")
	const parsed = parseInitiativeRef(ref);
	const effectiveRef = parsed.ref;
	const explicitInit = parsed.initiative;

	// First try exact track ID (only if no initiative prefix)
	if (!explicitInit) {
		const byId = loadRun(ref);
		if (byId) return byId;
	}

	// Normalize input for tolerant matching (agent-first)
	const normalizedRef = normalizePlanRef(effectiveRef) ?? effectiveRef;

	const allTracks = listRuns();

	// If explicit initiative provided, only search that initiative
	if (explicitInit) {
		for (const track of allTracks) {
			if (track.initiative === explicitInit) {
				const planRef = parsePlanRef(track.plan_path);
				if (
					planRef &&
					(planRef === effectiveRef || planRef === normalizedRef)
				) {
					return track;
				}
			}
		}
		return null;
	}

	// Otherwise use working initiative scoping
	const currentInit = getWorkingInitiative();

	// FIRST PASS: Current initiative only (01-10: initiative-scoped resolution)
	if (currentInit) {
		for (const track of allTracks) {
			if (track.initiative === currentInit) {
				const planRef = parsePlanRef(track.plan_path);
				if (
					planRef &&
					(planRef === effectiveRef || planRef === normalizedRef)
				) {
					return track;
				}
			}
		}

		// 01-10: If current initiative has the plan FILE, don't fall back to other initiatives
		// This ensures drafted plans in current initiative take precedence
		const planExistsInCurrentInit = checkPlanExistsInInitiative(
			effectiveRef,
			currentInit,
		);
		if (planExistsInCurrentInit) {
			return null; // Let caller handle (e.g., show fallback to plan file, activate auto-vivify)
		}
	}

	// SECOND PASS: Any initiative (only if plan doesn't exist in current initiative)
	for (const track of allTracks) {
		const planRef = parsePlanRef(track.plan_path);
		if (planRef && (planRef === effectiveRef || planRef === normalizedRef)) {
			return track;
		}
	}

	return null;
}

/**
 * Check if a plan file exists in the given initiative
 * 01-10: Helper for initiative-scoped resolution
 */
function checkPlanExistsInInitiative(ref: string, initiative: string): boolean {
	const phaseMatch = ref.match(/^(\d+(?:\.\d+)?)-/);
	if (!phaseMatch) return false;

	const phaseId = phaseMatch[1];
	const plansDir = join(process.cwd(), "plans", initiative);

	if (!existsSync(plansDir)) return false;

	try {
		const phaseDirs = readdirSync(plansDir, { withFileTypes: true });
		const phaseDir = phaseDirs.find(
			(d) => d.isDirectory() && (d.name === phaseId || d.name.startsWith(`${phaseId}-`))
		);

		if (phaseDir) {
			const planPath = join(plansDir, phaseDir.name, `${ref}-PLAN.md`);
			return existsSync(planPath);
		}
	} catch {
		// Ignore errors
	}

	return false;
}

/**
 * Resolve multiple track references (for commands that accept multiple)
 * Returns { found: Run[], notFound: string[] }
 */
export function resolveRunRefs(refs: string[]): {
	found: Run[];
	notFound: string[];
} {
	const found: Run[] = [];
	const notFound: string[] = [];

	for (const ref of refs) {
		const track = resolveRunRef(ref);
		if (track) {
			found.push(track);
		} else {
			notFound.push(ref);
		}
	}

	return { found, notFound };
}

// ============================================
// Event-sourced verification helpers (08-03-PLAN)
// ============================================

import type {
	DerivedCheck,
	VerificationCheckDef,
	VerificationEvent,
	VerificationSnapshot,
} from "../types/index.js";

/**
 * Append a verification event to a track (immutable - creates new events array)
 * Events are never mutated, only appended.
 */
export function appendVerificationEvent(
	track: Run,
	event: VerificationEvent,
): void {
	if (!track.verification) {
		track.verification = {};
	}
	if (!track.verification.events) {
		track.verification.events = [];
	}
	track.verification.events.push(event);
	track.updated = new Date().toISOString();
	saveRun(track);
}

/**
 * Derive verification snapshot from track events and current PLAN.md check definitions.
 *
 * Algorithm:
 *   for each check in current PLAN.md <verification>:
 *     find latest event (check_executed | manual_recorded) for this name
 *     if found → status from event
 *     else → status: pending
 *   manual_pending = any manual check with status = pending
 *
 * Note: Removed checks vanish from snapshot (events preserved for forensics)
 * Note: Re-runs append new events (full history visible)
 */
export function deriveVerificationSnapshot(
	track: Run,
	checkDefs: VerificationCheckDef[],
): VerificationSnapshot {
	const events = track.verification?.events ?? [];

	// Build derived checks from current PLAN definitions
	const checks: DerivedCheck[] = checkDefs.map((def) => {
		// Find latest event for this check
		const latestEvent = events
			.filter(
				(e) =>
					(e.type === "check_executed" || e.type === "manual_recorded") &&
					e.name === def.name,
			)
			.pop();

		const baseCheck: DerivedCheck = {
			name: def.name,
			kind: def.manual ? "manual" : "cmd",
			status: "pending",
			timeout: def.timeout,
		};

		if (!latestEvent) {
			return baseCheck;
		}

		if (latestEvent.type === "check_executed") {
			return {
				...baseCheck,
				status: latestEvent.status,
				exit_code: latestEvent.exit_code ?? undefined,
				output_tail: latestEvent.output_tail,
				updated_at: latestEvent.at,
				by: latestEvent.by,
			};
		}

		if (latestEvent.type === "manual_recorded") {
			return {
				...baseCheck,
				status: latestEvent.status,
				reason: latestEvent.reason,
				updated_at: latestEvent.at,
				by: latestEvent.by,
			};
		}

		return baseCheck;
	});

	// Compute manual_pending: any manual check still pending
	const manualPending = checks.some(
		(c) => c.kind === "manual" && c.status === "pending",
	);

	return {
		events,
		checks,
		manual_pending: manualPending,
	};
}

/**
 * Get aggregate verification status from snapshot.
 * Returns "pass" | "fail" | "pending"
 *
 * - Any fail|error → "fail"
 * - All pass → "pass"
 * - Otherwise → "pending"
 */
export function getVerificationStatus(
	snapshot: VerificationSnapshot,
): "pass" | "fail" | "pending" {
	if (snapshot.checks.length === 0) {
		return "pass";
	}

	const hasFailure = snapshot.checks.some(
		(c) => c.status === "fail" || c.status === "error",
	);
	if (hasFailure) {
		return "fail";
	}

	const allPass = snapshot.checks.every((c) => c.status === "pass");
	if (allPass) {
		return "pass";
	}

	return "pending";
}

// ============================================================================
// JSONL Sync - Git-trackable runs export/import
// ============================================================================

interface JsonlMetadata {
	version: string;
	exported_at: string;
	run_count: number;
}

interface SyncStats {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
}

/**
 * Export all runs to JSONL format for git tracking.
 * First line is metadata, subsequent lines are runs.
 */
export function exportRunsToJsonl(outputPath: string): { count: number } {
	const runs = listRuns();

	// Sort by id for deterministic output
	runs.sort((a, b) => a.id.localeCompare(b.id));

	const metadata: JsonlMetadata = {
		version: "1.0",
		exported_at: new Date().toISOString(),
		run_count: runs.length,
	};

	// Build JSONL content: metadata line + one line per run
	const lines = [
		JSON.stringify(metadata),
		...runs.map((run) => JSON.stringify(stripVersionMetadata(run))),
	];

	writeFileSync(outputPath, lines.join("\n") + "\n");

	return { count: runs.length };
}

/**
 * Import runs from JSONL, reconciling with local state.
 * - Missing locally: create from JSONL
 * - Local older (by updated timestamp): update from JSONL
 * - Local newer: keep local (will be exported later)
 */
export function importRunsFromJsonl(inputPath: string): SyncStats {
	if (!existsSync(inputPath)) {
		return { created: 0, updated: 0, unchanged: 0, skipped: 0 };
	}

	const content = readFileSync(inputPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);

	if (lines.length === 0) {
		return { created: 0, updated: 0, unchanged: 0, skipped: 0 };
	}

	const stats: SyncStats = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

	// First line is metadata, skip it
	const runLines = lines.slice(1);

	for (const line of runLines) {
		let jsonlRun: Run;
		try {
			jsonlRun = JSON.parse(line) as Run;
		} catch {
			stats.skipped++;
			continue;
		}

		if (!jsonlRun.id) {
			stats.skipped++;
			continue;
		}

		// Check local state
		const localRun = loadRun(jsonlRun.id);

		if (!localRun) {
			// Create from JSONL
			saveRun(jsonlRun);
			stats.created++;
		} else {
			// Compare timestamps
			const localUpdated = new Date(localRun.updated).getTime();
			const jsonlUpdated = new Date(jsonlRun.updated).getTime();

			if (jsonlUpdated > localUpdated) {
				// JSONL is newer - update local
				saveRun(jsonlRun);
				stats.updated++;
			} else {
				// Local is same or newer - keep local
				stats.unchanged++;
			}
		}
	}

	return stats;
}

/**
 * Get JSONL file path for runs sync
 */
export function getRunsJsonlPath(): string {
	return join(RUNS_DIR, "..", "runs.jsonl");
}
