/**
 * Phase state derivation - pure function from tracks
 *
 * Phase state is DERIVED, not stored. This eliminates drift between
 * "what phase says" and "what tracks say."
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Run } from "../types/index.js";
import { matchState } from "../types/index.js";
import { loadConfig } from "./config.js";
import { listRuns } from "./run.js";

// Phase states (derived from child track states)
export type PhaseState =
	| "proposed" // Phase in roadmap, no tracks created
	| "planning" // Tracks exist in proposed/approved
	| "active" // At least one track in active/*
	| "verifying" // All tracks in verifying/*
	| "complete"; // All tracks complete

// Phase info with derived state
export interface PhaseInfo {
	id: string; // e.g., "03.5"
	name: string; // e.g., "tiller-doctor"
	state: PhaseState; // Derived from tracks
	tracks: Run[]; // Child runs
	progress: {
		total: number;
		complete: number;
		active: number;
		verifying: number;
	};
	completed_at?: string; // max(track.completed_at) when all complete
}

/**
 * Derive phase state from child track states
 *
 * Priority logic:
 * - If no tracks: "proposed"
 * - If any track in proposed/approved: "planning"
 * - If any track in active/*: "active"
 * - If all tracks in verifying/*: "verifying"
 * - If all tracks complete: "complete"
 */
export function derivePhaseState(tracks: Run[]): PhaseState {
	if (tracks.length === 0) {
		return "proposed";
	}

	// Count tracks in each state category
	const complete = tracks.filter((t) => t.state === "complete").length;
	const verifying = tracks.filter((t) =>
		matchState(t.state, "verifying"),
	).length;
	const active = tracks.filter((t) => matchState(t.state, "active")).length;

	// All complete?
	if (complete === tracks.length) {
		return "complete";
	}

	// All in verifying (and some complete)?
	if (verifying + complete === tracks.length && verifying > 0) {
		return "verifying";
	}

	// Any active?
	if (active > 0) {
		return "active";
	}

	// Otherwise planning
	return "planning";
}

/**
 * Extract phase ID from a plan path
 * e.g., ".planning/phases/03.5-tiller-doctor/03.5-01-PLAN.md" -> "03.5"
 */
export function extractPhaseId(planPath: string): string | null {
	// Match patterns like "03.5-tiller-doctor" or "01-foundation"
	const match = planPath.match(/(\d+(?:\.\d+)?)-[^/]+\//);
	return match ? match[1] : null;
}

/**
 * Get phase info by phase ID
 */
export function getPhaseInfo(phaseId: string): PhaseInfo | null {
	const config = loadConfig();
	const phasesDir = config.paths.plans;

	// Find the phase directory
	if (!existsSync(phasesDir)) {
		return null;
	}

	const dirs = readdirSync(phasesDir);
	const phaseDir = dirs.find((d) => d.startsWith(`${phaseId}-`));

	if (!phaseDir) {
		return null;
	}

	// Extract phase name from directory (e.g., "03.5-tiller-doctor" -> "tiller-doctor")
	const phaseName = phaseDir.replace(/^\d+(?:\.\d+)?-/, "");

	// Find tracks for this phase
	const allTracks = listRuns();
	const phaseTracks = allTracks.filter((t: Run) => {
		const trackPhaseId = extractPhaseId(t.plan_path);
		return trackPhaseId === phaseId;
	});

	// Calculate progress
	const complete = phaseTracks.filter((t) => t.state === "complete").length;
	const active = phaseTracks.filter((t) =>
		matchState(t.state, "active"),
	).length;
	const verifying = phaseTracks.filter((t) =>
		matchState(t.state, "verifying"),
	).length;

	// Derive state
	const state = derivePhaseState(phaseTracks);

	// Get completed_at if all complete
	let completed_at: string | undefined;
	if (state === "complete" && phaseTracks.length > 0) {
		// Find the max updated timestamp among complete tracks
		const completeTracks = phaseTracks.filter((t) => t.state === "complete");
		completed_at = completeTracks.reduce(
			(max, t) => (t.updated > max ? t.updated : max),
			completeTracks[0].updated,
		);
	}

	return {
		id: phaseId,
		name: phaseName,
		state,
		tracks: phaseTracks,
		progress: {
			total: phaseTracks.length,
			complete,
			active,
			verifying,
		},
		completed_at,
	};
}

/**
 * Get all sub-phases for a major phase ID
 * @example getSubPhases("06") -> ["06.1", "06.2", "06.5", "06.6"]
 * @example getSubPhases("06.6") -> [] (no further sub-phases)
 */
export function getSubPhases(majorPhaseId: string): string[] {
	const config = loadConfig();
	const phasesDir = config.paths.plans;

	if (!existsSync(phasesDir)) {
		return [];
	}

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	const majorInt = parsePhaseId(majorPhaseId)[0];
	const subPhases: string[] = [];

	for (const dir of dirs) {
		const match = dir.match(/^(\d+)\.(\d+)-/);
		if (match && parseInt(match[1], 10) === majorInt) {
			subPhases.push(`${match[1]}.${match[2]}`);
		}
	}

	return subPhases.sort((a, b) => comparePhaseIds(a, b));
}

/**
 * Get aggregated phase info including all sub-phases
 * @example getAggregatedPhaseInfo("06") -> combined info for 06, 06.1, 06.2, etc.
 */
export function getAggregatedPhaseInfo(phaseId: string): PhaseInfo | null {
	const baseInfo = getPhaseInfo(phaseId);
	const subPhases = getSubPhases(phaseId);

	// If no sub-phases, return base info
	if (subPhases.length === 0) {
		return baseInfo;
	}

	// Aggregate all sub-phase info
	const allTracks: Run[] = baseInfo?.tracks || [];
	let totalComplete = baseInfo?.progress.complete || 0;
	let totalActive = baseInfo?.progress.active || 0;
	let totalVerifying = baseInfo?.progress.verifying || 0;

	for (const subId of subPhases) {
		const subInfo = getPhaseInfo(subId);
		if (subInfo) {
			allTracks.push(...subInfo.tracks);
			totalComplete += subInfo.progress.complete;
			totalActive += subInfo.progress.active;
			totalVerifying += subInfo.progress.verifying;
		}
	}

	// Derive aggregated state
	const state = derivePhaseState(allTracks);

	return {
		id: phaseId,
		name: baseInfo?.name || phaseId,
		state,
		tracks: allTracks,
		progress: {
			total: allTracks.length,
			complete: totalComplete,
			active: totalActive,
			verifying: totalVerifying,
		},
	};
}

/**
 * Get all phases from .planning/phases/
 */
export function getAllPhases(): PhaseInfo[] {
	const config = loadConfig();
	const phasesDir = config.paths.plans;

	if (!existsSync(phasesDir)) {
		return [];
	}

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	const phases: PhaseInfo[] = [];

	for (const dir of dirs) {
		// Extract phase ID (e.g., "03.5" from "03.5-tiller-doctor")
		const match = dir.match(/^(\d+(?:\.\d+)?)-/);
		if (!match) continue;

		const phaseId = match[1];
		const info = getPhaseInfo(phaseId);
		if (info) {
			phases.push(info);
		}
	}

	// Sort by phase ID (numeric sort handling decimals)
	return phases.sort((a, b) => {
		const parseId = (id: string) => {
			const parts = id.split(".");
			return parts.map((p) => parseInt(p, 10));
		};
		const aNum = parseId(a.id);
		const bNum = parseId(b.id);

		for (let i = 0; i < Math.max(aNum.length, bNum.length); i++) {
			const av = aNum[i] ?? 0;
			const bv = bNum[i] ?? 0;
			if (av !== bv) return av - bv;
		}
		return 0;
	});
}

/**
 * Get state symbol for display
 */
export function getPhaseStateSymbol(state: PhaseState): string {
	const symbols: Record<PhaseState, string> = {
		proposed: "○",
		planning: "◐",
		active: "●",
		verifying: "◑",
		complete: "✓",
	};
	return symbols[state];
}

/**
 * Phase state summary for roadmap progress table
 */
export interface PhaseStateSummary {
	phase: string;
	totalPlans: number;
	completedPlans: number;
	status: string;
	completedAt: string | null;
}

/**
 * Derive phase states from tracks for roadmap progress
 *
 * Groups tracks by phase and computes summary for each.
 */
export function derivePhaseStates(tracks: Run[]): PhaseStateSummary[] {
	// Group tracks by phase
	const phaseMap = new Map<
		string,
		{ tracks: Run[]; completedAt: string | null }
	>();

	for (const track of tracks) {
		const phaseId = extractPhaseId(track.plan_path);
		if (!phaseId) continue;

		const existing = phaseMap.get(phaseId) || { tracks: [], completedAt: null };
		existing.tracks.push(track);

		// Track latest completion time
		if (track.state === "complete" && track.updated) {
			if (!existing.completedAt || track.updated > existing.completedAt) {
				existing.completedAt = track.updated;
			}
		}

		phaseMap.set(phaseId, existing);
	}

	// Build summaries
	const summaries: PhaseStateSummary[] = [];

	for (const [
		phase,
		{ tracks: phaseTracks, completedAt },
	] of phaseMap.entries()) {
		const totalPlans = phaseTracks.length;
		const completedPlans = phaseTracks.filter(
			(t) => t.state === "complete",
		).length;
		const state = derivePhaseState(phaseTracks);

		// Map PhaseState to status string
		const statusMap: Record<PhaseState, string> = {
			proposed: "Not started",
			planning: "Planning",
			active: "In progress",
			verifying: "Verifying",
			complete: "Complete",
		};

		summaries.push({
			phase,
			totalPlans,
			completedPlans,
			status: statusMap[state],
			completedAt: state === "complete" ? completedAt : null,
		});
	}

	// Sort by phase ID (numeric sort handling decimals)
	return summaries.sort((a, b) => {
		const parseId = (id: string) => {
			const parts = id.split(".");
			return parts.map((p) => parseInt(p, 10));
		};
		const aNum = parseId(a.phase);
		const bNum = parseId(b.phase);

		for (let i = 0; i < Math.max(aNum.length, bNum.length); i++) {
			const av = aNum[i] ?? 0;
			const bv = bNum[i] ?? 0;
			if (av !== bv) return av - bv;
		}
		return 0;
	});
}

// ============================================================================
// Phase Management Helpers (for insert/remove commands)
// ============================================================================

/**
 * Generate kebab-case slug from description words
 * @example generateSlug(["State", "Machine", "Refactor"]) -> "state-machine-refactor"
 */
export function generateSlug(description: string[]): string {
	return description
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Parse phase ID into numeric parts for comparison
 * @example parsePhaseId("03.5") -> [3, 5]
 * @example parsePhaseId("07") -> [7]
 */
export function parsePhaseId(id: string): number[] {
	return id.split(".").map((p) => parseInt(p, 10));
}

/**
 * Compare two phase IDs numerically
 * @returns negative if a < b, positive if a > b, 0 if equal
 */
export function comparePhaseIds(a: string, b: string): number {
	const aNum = parsePhaseId(a);
	const bNum = parsePhaseId(b);

	for (let i = 0; i < Math.max(aNum.length, bNum.length); i++) {
		const av = aNum[i] ?? 0;
		const bv = bNum[i] ?? 0;
		if (av !== bv) return av - bv;
	}
	return 0;
}

/**
 * Find next available decimal phase after a base phase
 * @example findNextDecimal("03") with existing ["03.1", "03.2"] -> "03.3"
 * @example findNextDecimal("03") with no decimals -> "03.1"
 * @example findNextDecimal("03.1") with existing ["03.2"] -> "03.3"
 */
export function findNextDecimal(basePhase: string): string {
	const config = loadConfig();
	const phasesDir = config.paths.plans;

	if (!existsSync(phasesDir)) {
		// No phases exist yet, return .1
		const baseParts = parsePhaseId(basePhase);
		return `${baseParts[0].toString().padStart(2, "0")}.1`;
	}

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	// Get the base integer (e.g., "03" from "03.1" or just "03")
	const baseInt = parsePhaseId(basePhase)[0];
	const baseIntStr = baseInt.toString().padStart(2, "0");

	// Find all decimals for this base
	const decimals: number[] = [];
	for (const dir of dirs) {
		const match = dir.match(/^(\d+)\.(\d+)-/);
		if (match && parseInt(match[1], 10) === baseInt) {
			decimals.push(parseInt(match[2], 10));
		}
	}

	// Find next available decimal
	const nextDecimal = decimals.length > 0 ? Math.max(...decimals) + 1 : 1;
	return `${baseIntStr}.${nextDecimal}`;
}

/**
 * Check if a phase exists (has a directory)
 */
export function phaseExists(phaseId: string): boolean {
	const config = loadConfig();
	const phasesDir = config.paths.plans;

	if (!existsSync(phasesDir)) {
		return false;
	}

	const dirs = readdirSync(phasesDir);
	return dirs.some((d) => d.startsWith(`${phaseId}-`));
}

/**
 * Get the directory name for a phase
 * @example getPhaseDir("03.1") -> "03.1-tiller-doctor" or null
 */
export function getPhaseDir(phaseId: string): string | null {
	const config = loadConfig();
	const phasesDir = config.paths.plans;

	if (!existsSync(phasesDir)) {
		return null;
	}

	const dirs = readdirSync(phasesDir);
	return dirs.find((d) => d.startsWith(`${phaseId}-`)) ?? null;
}

/**
 * Get all integer phases (no decimal) that come after a given phase
 * Used for renumbering after removal
 * @example getPhasesToRenumber("07") with phases 07, 08, 09 -> [info for 08, 09]
 */
export function getPhasesToRenumber(removedPhase: string): PhaseInfo[] {
	const allPhases = getAllPhases();
	const removedInt = parsePhaseId(removedPhase)[0];

	// Only renumber integer phases that come after the removed one
	return allPhases
		.filter((p) => {
			const phaseNum = parsePhaseId(p.id);
			// Only integer phases (no decimal) that are greater
			return phaseNum.length === 1 && phaseNum[0] > removedInt;
		})
		.sort((a, b) => comparePhaseIds(a.id, b.id));
}

/**
 * Check if a phase has any completed work (SUMMARY.md files)
 */
export function phaseHasCompletedWork(phaseId: string): boolean {
	const config = loadConfig();
	const phasesDir = config.paths.plans;
	const phaseDir = getPhaseDir(phaseId);

	if (!phaseDir) {
		return false;
	}

	const fullPath = join(phasesDir, phaseDir);
	if (!existsSync(fullPath)) {
		return false;
	}

	const files = readdirSync(fullPath);
	return files.some((f) => f.endsWith("-SUMMARY.md"));
}

/**
 * Check if a phase has active work (tracks in active/* or verifying/*)
 */
export function phaseHasActiveWork(phaseId: string): boolean {
	const info = getPhaseInfo(phaseId);
	if (!info) {
		return false;
	}

	return info.tracks.some(
		(t) => matchState(t.state, "active") || matchState(t.state, "verifying"),
	);
}

/**
 * Rename a phase directory and all its contents
 * @param oldId - Current phase ID (e.g., "08")
 * @param newId - New phase ID (e.g., "07")
 */
export function renamePhaseDir(oldId: string, newId: string): void {
	const config = loadConfig();
	const phasesDir = config.paths.plans;
	const oldDir = getPhaseDir(oldId);

	if (!oldDir) {
		throw new Error(`Phase ${oldId} directory not found`);
	}

	// Extract slug from old directory name
	const slug = oldDir.replace(/^\d+(?:\.\d+)?-/, "");
	const newDirName = `${newId}-${slug}`;

	const oldPath = join(phasesDir, oldDir);
	const newPath = join(phasesDir, newDirName);

	// Rename directory
	renameSync(oldPath, newPath);

	// Rename files inside (e.g., 08-01-PLAN.md -> 07-01-PLAN.md)
	const files = readdirSync(newPath);
	for (const file of files) {
		if (file.startsWith(`${oldId}-`)) {
			const newFileName = file.replace(`${oldId}-`, `${newId}-`);
			renameSync(join(newPath, file), join(newPath, newFileName));
		}
	}
}

/**
 * Update frontmatter in all plan files within a phase directory
 * Updates the `phase:` field to reflect new phase ID
 */
export function updatePlanFrontmatter(
	phaseDir: string,
	oldId: string,
	newId: string,
): void {
	const config = loadConfig();
	const phasesDir = config.paths.plans;
	const fullPath = join(phasesDir, phaseDir);

	if (!existsSync(fullPath)) {
		return;
	}

	const files = readdirSync(fullPath).filter((f) => f.endsWith("-PLAN.md"));

	for (const file of files) {
		const filePath = join(fullPath, file);
		let content = readFileSync(filePath, "utf-8");

		// Update phase: field in frontmatter
		// Match pattern like "phase: 08-ax-testing" or "phase: 08"
		content = content.replace(
			new RegExp(`phase:\\s*${oldId}(-[^\\n]*)?`, "g"),
			(_match, slug) => `phase: ${newId}${slug || ""}`,
		);

		writeFileSync(filePath, content);
	}
}
