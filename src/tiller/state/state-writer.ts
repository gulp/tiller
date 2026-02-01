/**
 * STATE.md Authoritative section writer
 *
 * Tiller only writes to ## Authoritative section.
 * Respects ## Proposed ownership by ahoy.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { matchState } from "../types/index.js";
import { listRuns } from "./run.js";

interface AuthoritativeState {
	lastCompleted: string | null;
	activeTracks: number;
	completedTracks: number;
	lastExecution: string | null;
	completedPhases: Array<{ phase: string; plans: string; completed: string }>;
}

/**
 * Get STATE.md path for initiative
 *
 * Contract: specs/{initiative}/STATE.md
 * Legacy: .planning/STATE.md (initiative=null)
 */
export function getStatePath(initiative: string | null): string {
	if (initiative) {
		return `specs/${initiative}/STATE.md`;
	}
	return ".planning/STATE.md";
}

/**
 * Build ## Authoritative section content
 */
export function buildAuthoritativeSection(state: AuthoritativeState): string {
	const lines: string[] = [
		"## Authoritative",
		"<!-- Writer: tiller | Reader: ahoy -->",
		"<!-- Contains: actual state, completions, timestamps -->",
		"",
		`**Last completed:** ${state.lastCompleted || "None"}`,
		`**Active tracks:** ${state.activeTracks}`,
		`**Completed tracks:** ${state.completedTracks}`,
		`**Last execution:** ${state.lastExecution || "None"}`,
		"",
	];

	if (state.completedPhases.length > 0) {
		lines.push("### Completed Phases");
		lines.push("| Phase | Plans | Completed |");
		lines.push("|-------|-------|-----------|");
		for (const phase of state.completedPhases) {
			lines.push(`| ${phase.phase} | ${phase.plans} | ${phase.completed} |`);
		}
	}

	return lines.join("\n");
}

/**
 * Derive AuthoritativeState from tracks for an initiative
 */
function deriveAuthoritativeState(
	initiative: string | null,
): AuthoritativeState {
	// Get all tracks and filter by initiative
	const allTracks = listRuns();
	const tracks =
		initiative === null
			? allTracks.filter((t) => t.initiative === null)
			: allTracks.filter((t) => t.initiative === initiative);

	const active = tracks.filter((t) => matchState(t.state, "active"));
	const completed = tracks.filter((t) => t.state === "complete");

	// Group completed tracks by phase
	const phaseMap = new Map<
		string,
		{ total: number; completed: number; completedAt: string }
	>();
	for (const track of tracks) {
		const phaseId = extractPhaseFromPath(track.plan_path);
		if (!phaseId) continue;

		const existing = phaseMap.get(phaseId) || {
			total: 0,
			completed: 0,
			completedAt: "",
		};
		existing.total++;
		if (track.state === "complete") {
			existing.completed++;
			if (track.updated > existing.completedAt) {
				existing.completedAt = track.updated;
			}
		}
		phaseMap.set(phaseId, existing);
	}

	// Build completed phases list (only fully complete phases)
	const completedPhases: Array<{
		phase: string;
		plans: string;
		completed: string;
	}> = [];
	for (const [phase, info] of phaseMap.entries()) {
		if (info.completed === info.total && info.total > 0) {
			completedPhases.push({
				phase,
				plans: `${info.completed}/${info.total}`,
				completed: info.completedAt.split("T")[0],
			});
		}
	}

	// Sort by phase ID
	completedPhases.sort((a, b) => {
		const aNum = parseFloat(a.phase) || 0;
		const bNum = parseFloat(b.phase) || 0;
		return aNum - bNum;
	});

	return {
		lastCompleted: completed.length > 0 ? completed[0].id : null,
		activeTracks: active.length,
		completedTracks: completed.length,
		lastExecution: completed.length > 0 ? new Date().toISOString() : null,
		completedPhases,
	};
}

/**
 * Extract phase ID from plan path
 * e.g., "plans/tiller-cli/04-testing/04-01-PLAN.md" -> "04"
 */
function extractPhaseFromPath(planPath: string): string | null {
	const match = planPath.match(/(\d+(?:\.\d+)?)-[^/]+\/\d+-\d+-PLAN\.md$/);
	return match ? match[1] : null;
}

/**
 * Update STATE.md ## Authoritative section
 *
 * Only modifies content between "## Authoritative" and the next "##" header.
 * If no ## Authoritative section exists, does nothing (warns).
 */
export function updateStateAuthoritative(initiative: string | null): void {
	const statePath = getStatePath(initiative);
	if (!existsSync(statePath)) {
		console.warn(`STATE.md not found: ${statePath}`);
		return;
	}

	const content = readFileSync(statePath, "utf-8");

	// Find ## Authoritative section
	const authMatch = content.match(/^## Authoritative\n/m);
	if (!authMatch) {
		console.warn(`No ## Authoritative section in ${statePath}`);
		return;
	}

	// Find section boundaries
	const authStart = content.indexOf("## Authoritative");
	const afterAuth = content.slice(authStart + "## Authoritative".length);
	const nextSectionMatch = afterAuth.match(/\n## /);
	const authEnd = nextSectionMatch
		? authStart + "## Authoritative".length + nextSectionMatch.index!
		: content.length;

	// Build new authoritative content
	const state = deriveAuthoritativeState(initiative);
	const newAuthoritative = buildAuthoritativeSection(state);

	// Replace section
	const newContent =
		content.slice(0, authStart) +
		newAuthoritative +
		(nextSectionMatch ? content.slice(authEnd) : "");

	writeFileSync(statePath, newContent);
}
