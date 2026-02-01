/**
 * Run resolution utilities for verification commands
 *
 * Resolves run references (plan refs like "06.6-01", run IDs, or auto-detection)
 * and distinguishes between phase refs and plan refs.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../state/config.js";
import { getWorkingInitiative } from "../state/initiative.js";
import { findActiveRun, listRuns, resolveRunRef } from "../state/run.js";
import type { Run } from "../types/index.js";
import { matchState } from "../types/index.js";

/**
 * Result of run resolution for verification
 */
export interface RunVerifyResult {
	run: Run | null;
	planPath: string | null;
}

/**
 * Get run by plan ref, run ID, or find one in verifying/active state
 * If ref is provided but no run exists, tries to find PLAN.md file
 *
 * @param ref - Optional plan ref (e.g., "06.6-01") or run ID. If not provided,
 *              auto-detects by finding runs in verifying state first, then active.
 * @returns Object with run (if found) and planPath (if plan file exists without run)
 */
export function getRunForVerify(ref?: string): RunVerifyResult {
	if (ref) {
		const run = resolveRunRef(ref);
		if (run) {
			return { run, planPath: null };
		}

		// No run found, check if PLAN.md exists
		const planPath = resolvePlanRef(ref);
		return { run: null, planPath };
	}

	// Auto-detect run in verifying state first, then active
	const allRuns = listRuns();
	const verifying = allRuns.filter((r) => matchState(r.state, "verifying"));
	if (verifying.length > 0) {
		return { run: verifying[0], planPath: null };
	}

	const active = allRuns.filter((r) => matchState(r.state, "active"));
	if (active.length > 0) {
		return { run: active[0], planPath: null };
	}

	const activeRun = findActiveRun();
	return { run: activeRun, planPath: null };
}

/**
 * Check if ref is a phase ref (e.g., "06.6") vs plan ref (e.g., "06.6-01")
 *
 * @param ref - The reference string to check
 * @returns True if ref matches phase format (digits with optional decimal), false for plan refs
 */
export function isPhaseRef(ref: string): boolean {
	// Phase ref: just digits with optional decimal (e.g., "06", "06.6", "1.1")
	// Plan ref: digits-digits (e.g., "06.6-01", "02-03")
	return /^\d+(\.\d+)?$/.test(ref);
}

/**
 * Resolve a plan ref to a plan file path
 *
 * @param planRef - Plan reference (e.g., "06.6-01", "02-03")
 * @returns Absolute path to PLAN.md file, or null if not found
 */
export function resolvePlanRef(planRef: string): string | null {
	const config = loadConfig();
	const workingInit = getWorkingInitiative();
	const planFilename = `${planRef}-PLAN.md`;

	// Search in working initiative first, then all initiatives
	const searchDirs: string[] = [];

	if (workingInit) {
		searchDirs.push(join(config.paths.plans, workingInit));
	}

	// Add all initiative directories
	if (existsSync(config.paths.plans)) {
		const entries = readdirSync(config.paths.plans, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && !entry.name.startsWith(".")) {
				const initDir = join(config.paths.plans, entry.name);
				if (!searchDirs.includes(initDir)) {
					searchDirs.push(initDir);
				}
			}
		}
	}

	// Search each directory for the plan file
	for (const initDir of searchDirs) {
		if (!existsSync(initDir)) continue;

		const phases = readdirSync(initDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^\d+(\.\d+)?-/.test(e.name));

		for (const phase of phases) {
			const planPath = join(initDir, phase.name, planFilename);
			if (existsSync(planPath)) {
				return planPath;
			}
		}
	}

	return null;
}
