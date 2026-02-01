/**
 * SUMMARY.md utilities for verification
 *
 * Handles finding and parsing SUMMARY.md files associated with plans,
 * and extracting metadata from YAML frontmatter.
 */

import { existsSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Run } from "../types/index.js";
import { logEvent } from "../state/events.js";

/**
 * Find SUMMARY.md for a run's plan
 *
 * Searches for SUMMARY.md in the same directory as the plan file.
 * First tries `{plan-ref}-SUMMARY.md`, then falls back to `SUMMARY.md`.
 *
 * @param run - The run whose plan's SUMMARY.md to find
 * @returns Absolute path to SUMMARY.md, or null if not found
 */
export function findSummaryPath(run: Run): string | null {
	const planPath = run.plan_path;

	// SUMMARY.md is usually in the same directory as the PLAN.md
	const dir = dirname(planPath);
	const planBase = basename(planPath, ".md");
	const summaryBase = planBase.replace("-PLAN", "-SUMMARY");

	// Try stateful filenames first (autopass, done), then draft
	const candidates = [
		`${summaryBase}.autopass.md`,
		`${summaryBase}.done.md`,
		`${summaryBase}.md`,
	];

	for (const candidate of candidates) {
		const candidatePath = join(dir, candidate);
		if (existsSync(candidatePath)) {
			return candidatePath;
		}
	}

	// Try without the -PLAN suffix replacement
	const altCandidates = [
		"SUMMARY.autopass.md",
		"SUMMARY.done.md",
		"SUMMARY.md",
	];

	for (const candidate of altCandidates) {
		const candidatePath = join(dir, candidate);
		if (existsSync(candidatePath)) {
			return candidatePath;
		}
	}

	return null;
}

/**
 * Find finalized SUMMARY.done.md for a run's plan
 *
 * After verification passes, SUMMARY.md is renamed to SUMMARY.done.md.
 * This function finds the finalized version.
 *
 * @param run - The run whose plan's SUMMARY.done.md to find
 * @returns Absolute path to SUMMARY.done.md, or null if not found
 */
export function findFinalizedSummaryPath(run: Run): string | null {
	const planPath = run.plan_path;
	const dir = dirname(planPath);
	const planBase = basename(planPath, ".md");
	const summaryBase = planBase.replace("-PLAN", "-SUMMARY.done");
	const summaryPath = join(dir, `${summaryBase}.md`);

	if (existsSync(summaryPath)) {
		return summaryPath;
	}

	// Try generic fallback
	const altSummary = join(dir, "SUMMARY.done.md");
	if (existsSync(altSummary)) {
		return altSummary;
	}

	return null;
}

/** Options for finalizeSummary */
export interface FinalizeSummaryOptions {
	/** If true, create .autopass.md instead of .done.md (pending manual checks) */
	toAutopass?: boolean;
}

/**
 * Finalize SUMMARY.md by renaming to SUMMARY.done.md (or SUMMARY.autopass.md)
 *
 * Called after verification passes. Renames the draft SUMMARY.md to:
 * - SUMMARY.done.md if all checks passed (including manual)
 * - SUMMARY.autopass.md if automated checks passed but manual checks skipped
 *
 * @param run - The run whose SUMMARY.md to finalize
 * @param options - Optional settings for finalization
 * @returns Object with success status and paths
 */
export function finalizeSummary(
	run: Run,
	options?: FinalizeSummaryOptions,
): {
	success: boolean;
	fromPath?: string;
	toPath?: string;
	error?: string;
} {
	const summaryPath = findSummaryPath(run);

	if (!summaryPath) {
		return { success: false, error: "No SUMMARY.md found to finalize" };
	}

	// Already finalized?
	const finalizedPath = findFinalizedSummaryPath(run);
	if (finalizedPath) {
		// Clean up orphan draft if it exists
		if (existsSync(summaryPath) && summaryPath !== finalizedPath) {
			unlinkSync(summaryPath);
			logEvent({
				event: "summary_draft_cleaned",
				track: run.id,
				path: summaryPath,
			});
		}
		return {
			success: true,
			fromPath: summaryPath,
			toPath: finalizedPath,
			error: "Already finalized",
		};
	}

	// Check for autopass state
	const autopassPath = findAutopassSummaryPath(run);
	if (autopassPath && !options?.toAutopass) {
		// Already in autopass - upgrade to done
		const dir = dirname(autopassPath);
		const autopassBase = basename(autopassPath, ".md");
		const newPath = join(dir, `${autopassBase.replace("-SUMMARY.autopass", "-SUMMARY.done")}.md`);

		try {
			renameSync(autopassPath, newPath);
			logEvent({
				event: "summary_finalized",
				track: run.id,
				from: autopassPath,
				to: newPath,
			});
			return { success: true, fromPath: autopassPath, toPath: newPath };
		} catch (e) {
			return {
				success: false,
				fromPath: autopassPath,
				error: `Failed to rename: ${(e as Error).message}`,
			};
		}
	}

	// Determine target suffix based on options
	const targetSuffix = options?.toAutopass ? "-SUMMARY.autopass" : "-SUMMARY.done";
	const eventName = options?.toAutopass ? "summary_autopass" : "summary_finalized";

	// Rename SUMMARY.md to target
	const dir = dirname(summaryPath);
	const summaryBase = basename(summaryPath, ".md");
	const newPath = join(dir, `${summaryBase.replace("-SUMMARY", targetSuffix)}.md`);

	try {
		renameSync(summaryPath, newPath);
		logEvent({
			event: eventName,
			track: run.id,
			from: summaryPath,
			to: newPath,
		});
		return { success: true, fromPath: summaryPath, toPath: newPath };
	} catch (e) {
		return {
			success: false,
			fromPath: summaryPath,
			error: `Failed to rename: ${(e as Error).message}`,
		};
	}
}

/**
 * Find SUMMARY.autopass.md for a run's plan
 *
 * The autopass state indicates automated checks passed but manual checks
 * are pending verification.
 *
 * @param run - The run whose plan's SUMMARY.autopass.md to find
 * @returns Absolute path to SUMMARY.autopass.md, or null if not found
 */
export function findAutopassSummaryPath(run: Run): string | null {
	const planPath = run.plan_path;
	const dir = dirname(planPath);
	const planBase = basename(planPath, ".md");
	const summaryBase = planBase.replace("-PLAN", "-SUMMARY.autopass");
	const summaryPath = join(dir, `${summaryBase}.md`);

	if (existsSync(summaryPath)) {
		return summaryPath;
	}

	// Try generic fallback
	const altSummary = join(dir, "SUMMARY.autopass.md");
	if (existsSync(altSummary)) {
		return altSummary;
	}

	return null;
}

/**
 * Extract files_modified from YAML frontmatter
 *
 * Parses the `files_modified: [file1, file2]` array from plan content.
 * Handles both quoted and unquoted file paths.
 *
 * @param planContent - Full content of PLAN.md file
 * @returns Array of file paths, or empty array if not found
 */
export function extractFilesModified(planContent: string): string[] {
	const match = planContent.match(/files_modified:\s*\[([^\]]*)\]/);
	if (!match) return [];
	return match[1]
		.split(",")
		.map((f) => f.trim().replace(/['"]/g, ""))
		.filter(Boolean);
}
