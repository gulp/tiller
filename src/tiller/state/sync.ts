/**
 * Sync draft plans to tiller runs
 */

import { existsSync, readFileSync } from "node:fs";
import { globSync } from "glob";
import { getConfigPaths } from "./config.js";
import { parseInitiativeFromPath } from "./initiative.js";
import { createRun, listRuns } from "./run.js";

export interface SyncResult {
	imported: string[];
	alreadyTracked: number;
	errors: string[];
}

/**
 * Find draft plan files that don't have corresponding tiller runs
 */
export function findDraftPlans(): string[] {
	const { PLANS_DIR } = getConfigPaths();

	// Look for plans in the configured plans directory
	// Pattern: plans/<initiative>/<phase>/*-PLAN.md
	const planFiles = globSync(`${PLANS_DIR}/**/*-PLAN.md`);

	const existingTracks = listRuns();
	const trackedPaths = new Set(existingTracks.map((t) => t.plan_path));

	return planFiles.filter((p) => {
		if (trackedPaths.has(p)) return false;
		// Skip completed plans (have SUMMARY.md)
		const summaryPath = p.replace(/-PLAN\.md$/i, "-SUMMARY.md");
		return !existsSync(summaryPath);
	});
}

/**
 * Sync draft plans by creating tiller runs for them
 */
export function syncDraftPlans(): SyncResult {
	const drafts = findDraftPlans();
	const result: SyncResult = {
		imported: [],
		alreadyTracked: listRuns().length,
		errors: [],
	};

	for (const planPath of drafts) {
		try {
			// Validate path format first
			parseInitiativeFromPath(planPath);

			// Extract intent from plan (first line of objective or filename)
			const content = readFileSync(planPath, "utf-8");
			const objectiveMatch = content.match(/<objective>\s*([^\n]+)/);
			const intent =
				objectiveMatch?.[1] ||
				planPath
					.split("/")
					.pop()
					?.replace(/-PLAN\.md$/i, "") ||
				"Unknown";

			// Plans in plans/ are supply-side, skip proposed (ADR-0005)
			createRun(planPath, intent.trim(), "ready");
			result.imported.push(planPath);
		} catch (e) {
			result.errors.push(
				`${planPath}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	return result;
}
