/**
 * Phase-level verification health checks
 *
 * Provides phase-level aggregated verification status.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../state/config.js";
import {
	getAggregatedPhaseInfo,
	getPhaseDir,
	getPhaseInfo,
	getSubPhases,
} from "../state/phase.js";
import { parsePlanRef } from "../state/run.js";
import { findSummaryPath } from "./summary.js";

export interface PhaseHealthCheck {
	name: string;
	passed: boolean;
	details?: string[];
}

export interface PhaseHealthReport {
	phaseId: string;
	hasSubPhases: boolean;
	subPhases?: Array<{
		id: string;
		state: string;
		complete: number;
		total: number;
	}>;
	plans: Array<{
		ref: string;
		status: string;
	}>;
	checks: PhaseHealthCheck[];
	summary: {
		total: number;
		complete: number;
		active: number;
		verifying: number;
		state: string;
	};
}

/**
 * Run phase-level health check and return structured report
 *
 * Executes TSC, git status, and SUMMARY.md checks. For phases with sub-phases,
 * aggregates results across all sub-phases.
 *
 * @param phaseId - Phase identifier (e.g., "06" or "06.6")
 * @returns PhaseHealthReport with check results, or null if phase not found
 */
export async function getPhaseHealthReport(
	phaseId: string,
): Promise<PhaseHealthReport | null> {
	// Check for sub-phases (e.g., "06" has "06.1", "06.2", etc.)
	const subPhases = getSubPhases(phaseId);
	const hasSubPhases = subPhases.length > 0;

	// Use aggregated info if there are sub-phases
	const info = hasSubPhases
		? getAggregatedPhaseInfo(phaseId)
		: getPhaseInfo(phaseId);
	if (!info) {
		return null;
	}

	const config = loadConfig();
	const phasesDir = config.paths.plans;
	const checks: PhaseHealthCheck[] = [];

	// Build sub-phases summary if applicable
	const subPhasesData = hasSubPhases
		? subPhases.map((subId) => {
				const subInfo = getPhaseInfo(subId);
				return subInfo
					? {
							id: subId,
							state: subInfo.state,
							complete: subInfo.progress.complete,
							total: subInfo.progress.total,
						}
					: { id: subId, state: "unknown", complete: 0, total: 0 };
			})
		: undefined;

	// Collect all plans
	const plans: Array<{ ref: string; status: string }> = [];

	const collectPhasePlans = async (pId: string) => {
		const phaseDir = getPhaseDir(pId);
		if (phaseDir) {
			const fullPath = join(phasesDir, phaseDir);
			if (existsSync(fullPath)) {
				const files = readdirSync(fullPath)
					.filter((f: string) => f.endsWith("-PLAN.md"))
					.sort();

				for (const file of files) {
					const ref = file.replace("-PLAN.md", "");
					const track = info.tracks.find(
						(t) => parsePlanRef(t.plan_path) === ref,
					);
					plans.push({ ref, status: track?.state || "proposed" });
				}
			}
		}
	};

	// Collect base phase plans
	const basePhaseDir = getPhaseDir(phaseId);
	if (basePhaseDir) {
		await collectPhasePlans(phaseId);
	}

	// Collect sub-phase plans
	if (hasSubPhases) {
		for (const subId of subPhases) {
			await collectPhasePlans(subId);
		}
	}

	// TSC check
	let tscPassed = false;
	let tscError: string | undefined;
	try {
		execSync("tsc --noEmit", { stdio: "pipe" });
		tscPassed = true;
	} catch (err) {
		tscPassed = false;
		// Distinguish "tsc not found" from "type errors exist"
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			tscError = "tsc not found - is TypeScript installed?";
		}
		// Otherwise it's a genuine type error, which is expected behavior
	}
	checks.push({
		name: "tsc --noEmit",
		passed: tscPassed,
		...(tscError && { details: [tscError] }),
	});

	// Git status check
	let gitClean = false;
	let gitError: string | undefined;
	try {
		const gitStatus = execSync("git status --porcelain", { encoding: "utf-8" });
		gitClean = gitStatus.trim() === "";
	} catch (err) {
		gitClean = false;
		// Distinguish "git not found" from "not a git repo"
		if (err instanceof Error && "code" in err && err.code === "ENOENT") {
			gitError = "git not found";
		} else if (
			err instanceof Error &&
			err.message.includes("not a git repository")
		) {
			gitError = "not a git repository";
		}
	}
	checks.push({
		name: "git status clean",
		passed: gitClean,
		...(gitError && { details: [gitError] }),
	});

	// SUMMARY.md check for completed plans
	const completedTracks = info.tracks.filter((t) => t.state === "complete");
	const missingSummaries: string[] = [];
	for (const track of completedTracks) {
		const summaryPath = findSummaryPath(track);
		if (!summaryPath) {
			const ref = parsePlanRef(track.plan_path) || track.id;
			missingSummaries.push(ref);
		}
	}

	if (completedTracks.length > 0) {
		checks.push({
			name: "SUMMARY.md",
			passed: missingSummaries.length === 0,
			details:
				missingSummaries.length > 0
					? missingSummaries.map((ref) => `missing: ${ref}`)
					: undefined,
		});
	}

	return {
		phaseId,
		hasSubPhases,
		subPhases: subPhasesData,
		plans,
		checks,
		summary: {
			total: info.progress.total,
			complete: info.progress.complete,
			active: info.progress.active,
			verifying: info.progress.verifying,
			state: info.state,
		},
	};
}

/**
 * Format phase health report for console output
 *
 * Renders the health report as a human-readable string with icons and sections
 * for sub-phases, plans, checks, and summary.
 *
 * @param report - The health report to format
 * @returns Formatted string suitable for console output
 */
export function formatPhaseHealthReport(report: PhaseHealthReport): string {
	const lines: string[] = [];

	lines.push(
		`Phase ${report.phaseId} Health Check${report.hasSubPhases ? " (aggregated)" : ""}`,
	);
	lines.push("═".repeat(55));

	// Sub-phases
	if (report.subPhases && report.subPhases.length > 0) {
		lines.push("\nSub-phases:");
		for (const sub of report.subPhases) {
			const icon =
				sub.state === "complete" ? "✓" : sub.state === "active" ? "●" : "○";
			lines.push(
				`  ${icon} ${sub.id} [${sub.state}] (${sub.complete}/${sub.total} complete)`,
			);
		}
	}

	// Plans
	lines.push("\nPlans:");
	for (const plan of report.plans) {
		const icon =
			plan.status === "complete" ? "✓" : plan.status === "proposed" ? "○" : "●";
		lines.push(`  ${icon} ${plan.ref} [${plan.status}]`);
	}

	// Checks
	lines.push("\nChecks:");
	for (const check of report.checks) {
		const icon = check.passed ? "✓" : "✗";
		lines.push(`  ${icon} ${check.name}`);
		if (check.details) {
			for (const detail of check.details) {
				lines.push(`      ${detail}`);
			}
		}
	}

	// Summary
	lines.push("\nSummary:");
	lines.push(`  Total: ${report.summary.total} plans`);
	lines.push(`  Complete: ${report.summary.complete}`);
	lines.push(`  Active: ${report.summary.active}`);
	lines.push(`  Verifying: ${report.summary.verifying}`);
	lines.push(`  Phase state: ${report.summary.state}`);

	return lines.join("\n");
}
