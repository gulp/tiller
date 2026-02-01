/**
 * Initiative derivation from PLAN.md paths
 *
 * ADR-0005 Contract: plans/{initiative}/{phase}/{phase}-{plan}-PLAN.md
 * Legacy (deprecated): .planning/phases/XX-name/XX-YY-PLAN.md
 * Legacy (deprecated): specs/{initiative}/phases/XX-name/XX-YY-PLAN.md
 */

import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import { CORE_PATHS } from "./paths.js";

/**
 * Get working initiative from config, with fallback to default
 * Returns null only if neither is set
 */
export function getWorkingInitiative(): string | null {
	const config = loadConfig();
	// Check workflow.working_initiative first (explicit user selection)
	// Migration: also check deprecated current_initiative
	const working = config.workflow.working_initiative ?? config.workflow.current_initiative;
	if (working) {
		return working;
	}
	// Fall back to config default
	return config.paths.default_initiative || null;
}

/**
 * Check if there's an EXPLICIT focus set (excludes default_initiative fallback)
 * Use this to determine if user has intentionally focused on an initiative
 */
export function hasExplicitFocus(): boolean {
	const config = loadConfig();
	return !!(config.workflow.working_initiative ?? config.workflow.current_initiative);
}

/** @deprecated Use getWorkingInitiative instead */
export const getCurrentInitiative = getWorkingInitiative;

/**
 * Set working initiative in config
 * Pass null to clear (will fall back to paths.default_initiative)
 */
export function setWorkingInitiative(initiative: string | null): void {
	const config = loadConfig();
	if (initiative === null) {
		delete config.workflow.working_initiative;
		delete config.workflow.current_initiative; // Clean up deprecated
	} else {
		config.workflow.working_initiative = initiative;
		delete config.workflow.current_initiative; // Clean up deprecated
	}
	saveConfig(config);
}

/** @deprecated Use setWorkingInitiative instead */
export const setCurrentInitiative = setWorkingInitiative;

/**
 * Get the effective initiative for commands
 * Priority: explicit flag > working state > config default
 */
export function resolveInitiative(explicit?: string): string | null {
	if (explicit) return explicit;
	return getWorkingInitiative();
}

export interface InitiativeInfo {
	initiative: string | null; // null for legacy paths without initiative
	phase: string;
	plan: string;
	isContractCompliant: boolean;
}

export function parseInitiativeFromPath(planPath: string): InitiativeInfo {
	// Normalize absolute paths to relative (Postel's Law)
	let normalizedPath = planPath;
	if (planPath.startsWith(CORE_PATHS.PROJECT_ROOT)) {
		normalizedPath = planPath.slice(CORE_PATHS.PROJECT_ROOT.length + 1); // +1 for trailing /
	}

	// ADR-0005 contract path: plans/{initiative}/{phase}/{phase}-{plan}-PLAN.md
	// Supports decimal phases: XX.X (e.g., 06.5-01-PLAN.md)
	// Supports -FIX- suffix for hotfix plans (e.g., 03.1-03-FIX-PLAN.md, 06.2-FIX-PLAN.md)
	const contractMatch = normalizedPath.match(
		/^plans\/([^/]+)\/([^/]+)\/(\d+(?:\.\d+)?)(?:-(\d+))?(?:-FIX)?-PLAN\.md$/,
	);
	if (contractMatch) {
		return {
			initiative: contractMatch[1],
			phase: contractMatch[2],
			plan: contractMatch[4] ?? "FIX", // Default to "FIX" for phase-only FIX plans
			isContractCompliant: true,
		};
	}

	// Legacy path: .planning/phases/XX-name/XX-YY-PLAN.md (deprecated)
	const legacyPlanningMatch = normalizedPath.match(
		/^\.planning\/phases\/([^/]+)\/(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/,
	);
	if (legacyPlanningMatch) {
		return {
			initiative: null,
			phase: legacyPlanningMatch[1],
			plan: legacyPlanningMatch[3],
			isContractCompliant: false,
		};
	}

	// Legacy path: specs/{initiative}/phases/XX-name/XX-YY-PLAN.md (deprecated)
	const legacySpecsMatch = normalizedPath.match(
		/^specs\/([^/]+)\/phases\/([^/]+)\/(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/,
	);
	if (legacySpecsMatch) {
		return {
			initiative: legacySpecsMatch[1],
			phase: legacySpecsMatch[2],
			plan: legacySpecsMatch[4],
			isContractCompliant: false,
		};
	}

	throw new Error(
		`Invalid PLAN.md path: ${normalizedPath}. Expected: plans/{initiative}/{phase}/{phase}-{plan}-PLAN.md`,
	);
}

/**
 * Build a track ID from initiative info
 *
 * @deprecated No longer used - run IDs are immutable (run-{random})
 *
 * Historical context:
 * - v0.1.x: Used plan refs as run IDs (mutable, tied to phase numbering)
 * - v0.2.0: Contract format {initiative}--{phase}-{plan} (still mutable)
 * - v0.3.0+: Immutable run-{random} IDs with plan_path as source of truth
 *
 * Kept for backward compatibility with archived plans and documentation.
 */
export function buildTrackId(info: InitiativeInfo): string {
	// Extract phase number from phase name (e.g., "04-testing" -> "04", "06.5-prime" -> "06.5")
	const phaseNum = info.phase.match(/^(\d+(?:\.\d+)?)/)?.[1] ?? info.phase;

	// Contract: {initiative}--{phase}-{plan}
	// Legacy: {phase}-{plan}
	if (info.initiative) {
		return `${info.initiative}--${phaseNum}-${info.plan}`;
	}
	return `${phaseNum}-${info.plan}`;
}

/**
 * Get the plans directory path for the current or specified initiative
 * Returns: plans/{initiative}/ or plans/ (if no initiative)
 */
export function resolvePhasesDir(explicit?: string): string {
	const config = loadConfig();
	const initiative = resolveInitiative(explicit);
	if (initiative) {
		return join(config.paths.plans, initiative);
	}
	return config.paths.plans;
}

/**
 * Parse a run ID to extract initiative, phase, and plan components
 *
 * @deprecated No longer used - run IDs are immutable (run-{random})
 *
 * Historical context:
 * - v0.1.x: Used plan refs as run IDs (mutable, tied to phase numbering)
 * - v0.2.0: Contract format {initiative}--{phase}-{plan} (still mutable)
 * - v0.3.0+: Immutable run-{random} IDs with plan_path as source of truth
 *
 * Kept for backward compatibility with archived plans and documentation.
 * Run IDs can no longer be parsed to extract semantic information.
 */
export function parseRunId(runId: string): {
	initiative: string | null;
	phase: string;
	plan: string;
} {
	// Contract format: tiller--04-01
	if (runId.includes("--")) {
		const [initiative, phasePlan] = runId.split("--");
		const lastDash = phasePlan.lastIndexOf("-");
		return {
			initiative,
			phase: phasePlan.slice(0, lastDash),
			plan: phasePlan.slice(lastDash + 1),
		};
	}

	// Legacy format: 04-name-01
	const lastDash = runId.lastIndexOf("-");
	return {
		initiative: null,
		phase: runId.slice(0, lastDash),
		plan: runId.slice(lastDash + 1),
	};
}

/** @deprecated Use parseRunId */
export const parseTrackId = parseRunId;
