/**
 * ROADMAP.md Progress section writer
 *
 * Tiller only writes to ## Progress section.
 * Respects ## Phases ownership by ahoy.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { derivePhaseStates, type PhaseStateSummary } from "./phase.js";
import { listRuns } from "./run.js";

interface PhaseProgress {
	phase: string;
	plansComplete: string;
	status: string;
	completed: string;
}

/**
 * Get ROADMAP.md path for initiative
 *
 * Contract: specs/{initiative}/ROADMAP.md
 * Legacy: .planning/ROADMAP.md (initiative=null)
 */
export function getRoadmapPath(initiative: string | null): string {
	if (initiative) {
		return `specs/${initiative}/ROADMAP.md`;
	}
	return ".planning/ROADMAP.md";
}

/**
 * Build ## Progress section content
 */
export function buildProgressSection(phases: PhaseProgress[]): string {
	const lines: string[] = [
		"## Progress",
		"<!-- Writer: tiller -->",
		"",
		"| Phase | Plans | Status | Completed |",
		"|-------|-------|--------|-----------|",
	];

	for (const phase of phases) {
		lines.push(
			`| ${phase.phase} | ${phase.plansComplete} | ${phase.status} | ${phase.completed} |`,
		);
	}

	return lines.join("\n");
}

/**
 * Convert PhaseStateSummary to PhaseProgress format
 */
function toPhaseProgress(summary: PhaseStateSummary): PhaseProgress {
	return {
		phase: summary.phase,
		plansComplete: `${summary.completedPlans}/${summary.totalPlans}`,
		status: summary.status,
		completed: summary.completedAt ? summary.completedAt.split("T")[0] : "-",
	};
}

/**
 * Update ROADMAP.md ## Progress section
 *
 * Only modifies content between "## Progress" and the next "##" header.
 * If no ## Progress section exists, appends one at the end.
 */
export function updateRoadmapProgress(initiative: string | null): void {
	const roadmapPath = getRoadmapPath(initiative);
	if (!existsSync(roadmapPath)) {
		console.warn(`ROADMAP.md not found: ${roadmapPath}`);
		return;
	}

	const content = readFileSync(roadmapPath, "utf-8");

	// Get all tracks for this initiative
	const allTracks = listRuns();
	const tracks =
		initiative === null
			? allTracks.filter((t) => t.initiative === null)
			: allTracks.filter((t) => t.initiative === initiative);

	// Derive phase states from tracks
	const phaseStates = derivePhaseStates(tracks);
	const phases: PhaseProgress[] = phaseStates.map(toPhaseProgress);
	const newProgress = buildProgressSection(phases);

	// Find ## Progress section
	const progressMatch = content.match(/^## Progress\n/m);
	if (!progressMatch) {
		// Append if doesn't exist
		const appendedContent = `${content.trimEnd()}\n\n${newProgress}\n`;
		writeFileSync(roadmapPath, appendedContent);
		return;
	}

	// Find section boundaries
	const progressStart = content.indexOf("## Progress");
	const afterProgress = content.slice(progressStart + "## Progress".length);
	const nextSectionMatch = afterProgress.match(/\n## /);
	const progressEnd = nextSectionMatch
		? progressStart + "## Progress".length + nextSectionMatch.index!
		: content.length;

	// Replace section
	const newContent =
		content.slice(0, progressStart) +
		newProgress +
		(nextSectionMatch ? content.slice(progressEnd) : "");

	writeFileSync(roadmapPath, newContent);
}
