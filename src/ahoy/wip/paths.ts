/**
 * WIP path utilities for ahoy artifact management
 * Provides consistent path handling for Work-In-Progress artifacts
 */

import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Base WIP directory path
 */
export function getWipBase(cwd: string = process.cwd()): string {
	return join(cwd, ".ahoy", "wip");
}

/**
 * WIP directory for a specific initiative and phase
 */
export function getWipDir(
	initiative: string,
	phase: string,
	cwd?: string,
): string {
	return join(getWipBase(cwd), initiative, phase);
}

/**
 * Path to WIP CONTEXT.md
 */
export function getWipContextPath(
	initiative: string,
	phase: string,
	cwd?: string,
): string {
	return join(getWipDir(initiative, phase, cwd), "CONTEXT.md");
}

/**
 * Path to WIP RESEARCH.md
 */
export function getWipResearchPath(
	initiative: string,
	phase: string,
	cwd?: string,
): string {
	return join(getWipDir(initiative, phase, cwd), "RESEARCH.md");
}

/**
 * Path to WIP DISCOVERY.md
 */
export function getWipDiscoveryPath(
	initiative: string,
	phase: string,
	cwd?: string,
): string {
	return join(getWipDir(initiative, phase, cwd), "DISCOVERY.md");
}

/**
 * Path to a specific WIP plan file
 */
export function getWipPlanPath(
	initiative: string,
	phase: string,
	planNum: string,
	cwd?: string,
): string {
	return join(getWipDir(initiative, phase, cwd), `${planNum}-PLAN.md`);
}

/**
 * List all WIP plan files for a phase
 * Returns plan filenames (e.g., ["01-PLAN.md", "02-PLAN.md"])
 */
export async function listWipPlans(
	initiative: string,
	phase: string,
	cwd?: string,
): Promise<string[]> {
	const wipDir = getWipDir(initiative, phase, cwd);

	if (!existsSync(wipDir)) {
		return [];
	}

	const files = await readdir(wipDir);
	return files.filter((f) => f.endsWith("-PLAN.md")).sort();
}

/**
 * Ensure WIP directory exists for a phase
 */
export async function ensureWipDir(
	initiative: string,
	phase: string,
	cwd?: string,
): Promise<void> {
	const wipDir = getWipDir(initiative, phase, cwd);
	await mkdir(wipDir, { recursive: true });
}

/**
 * WIP artifacts status for a phase
 */
export interface WipArtifacts {
	context: boolean;
	research: boolean;
	discovery: boolean;
	plans: string[];
}

/**
 * Check what WIP artifacts exist for a phase
 */
export async function getWipArtifacts(
	initiative: string,
	phase: string,
	cwd?: string,
): Promise<WipArtifacts> {
	return {
		context: existsSync(getWipContextPath(initiative, phase, cwd)),
		research: existsSync(getWipResearchPath(initiative, phase, cwd)),
		discovery: existsSync(getWipDiscoveryPath(initiative, phase, cwd)),
		plans: await listWipPlans(initiative, phase, cwd),
	};
}
