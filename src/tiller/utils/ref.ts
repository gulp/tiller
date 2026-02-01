/**
 * Reference resolution utilities
 *
 * ## Notation (agent-first clarity)
 *
 * | Format    | Type           | Example    |
 * |-----------|----------------|------------|
 * | XX        | Integer phase  | 06         |
 * | XX-YY     | Plan (int)     | 06-01      |
 * | XX.X      | Decimal phase  | 06.1       |
 * | XX.X-YY   | Plan (decimal) | 06.1-05    |
 *
 * ## Tolerant parsing
 *
 * Agents may produce variations from training data:
 * - 06.6-25 (canonical)
 * - 06.6.-25 (extra dot)
 * - 06-6-25 (wrong separator)
 * - 06.6.25 (dot instead of dash)
 * - Full paths
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../state/config.js";

// ============================================================================
// Types
// ============================================================================

export type RefType = "plan" | "phase";

export interface ParsedInitiativeRef {
	initiative: string | null;
	ref: string;
}

// ============================================================================
// Initiative Prefix Parsing
// ============================================================================

/**
 * Parse initiative:ref format (e.g., "dogfooding:01-19")
 *
 * Pattern matches docker image:tag, k8s namespace/resource
 */
export function parseInitiativeRef(input: string): ParsedInitiativeRef {
	const colonIndex = input.indexOf(":");
	// Only treat as initiative prefix if colon is followed by a digit (ref starts with number)
	// This avoids false positives on Windows paths or other colon uses
	if (colonIndex > 0 && /^\d/.test(input.slice(colonIndex + 1))) {
		return {
			initiative: input.slice(0, colonIndex),
			ref: input.slice(colonIndex + 1),
		};
	}
	return { initiative: null, ref: input };
}

export interface ResolvedRef {
	type: RefType;
	canonical: string; // "06.6-25" for plan, "06.6" for phase
	path: string; // Full filesystem path
}

// Extended types for callers that need more detail
export interface ResolvedPlan extends ResolvedRef {
	type: "plan";
	phaseId: string;
	planNumber: number;
}

export interface ResolvedPhase extends ResolvedRef {
	type: "phase";
	dir: string; // Directory name (e.g., "06.6-tiller-ax")
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Resolve any reference (plan or phase) to its canonical form and path.
 *
 * Accepts:
 * - Plan refs: 06.6-25, 6.6-25, 06-6-25, 06.6.25
 * - Phase IDs: 06.6, 6.6, 06-6, 06
 * - Full paths: .planning/phases/06.6-name/06.6-25-PLAN.md
 * - Initiative-prefixed: dogfooding:01-19, tiller-cli:06.6-25
 *
 * @param input - The reference string to resolve
 * @param initiative - Optional initiative override (if not in input)
 * @returns ResolvedRef with type, canonical form, and path
 */
export function resolveRef(
	input: string,
	initiative?: string,
): ResolvedRef | null {
	// Parse initiative:ref syntax
	const parsed = parseInitiativeRef(input);
	const effectiveInitiative = parsed.initiative ?? initiative;
	const ref = parsed.ref;

	// Determine plans directory
	const config = loadConfig();
	let phasesDir: string;
	if (effectiveInitiative) {
		// Look in plans/<initiative>/
		phasesDir = join(config.paths.plans, effectiveInitiative);
	} else {
		// Use default initiative
		const defaultInit = config.paths.default_initiative ?? "tiller-cli";
		phasesDir = join(config.paths.plans, defaultInit);
	}

	// Try as plan ref first (more specific)
	const plan = resolvePlanRef(ref, phasesDir);
	if (plan) return plan;

	// Try as phase ID
	const phase = resolvePhaseId(ref, phasesDir);
	if (phase) return phase;

	return null;
}

// ============================================================================
// Normalization (exported for direct use and testing)
// ============================================================================

/**
 * Normalize a plan reference to canonical format (XX.X-YY or XX-YY)
 */
export function normalizePlanRef(input: string): string | null {
	const cleaned = input.trim();

	// Decimal phase patterns (e.g., 06.6-25)
	const decimalPatterns = [
		/^(\d{1,2})\.(\d{1,2})-(\d{1,3})$/, // 06.6-25
		/^(\d{1,2})\.(\d{1,2})\.-(\d{1,3})$/, // 06.6.-25
		/^(\d{1,2})-(\d{1,2})-(\d{1,3})$/, // 06-6-25
		/^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/, // 06.6.25
	];

	for (const pattern of decimalPatterns) {
		const match = cleaned.match(pattern);
		if (match) {
			const [, major, minor, plan] = match;
			return `${major.padStart(2, "0")}.${minor}-${plan.padStart(2, "0")}`;
		}
	}

	// Integer phase pattern (e.g., 08-14, 11-17)
	const intMatch = cleaned.match(/^(\d{1,2})-(\d{1,3})$/);
	if (intMatch) {
		const [, phase, plan] = intMatch;
		return `${phase.padStart(2, "0")}-${plan.padStart(2, "0")}`;
	}

	return null;
}

/**
 * Normalize a phase ID to canonical format (XX.X or XX)
 */
export function normalizePhaseId(input: string): string | null {
	const cleaned = input.trim();

	// Decimal phase: 06.6, 6.6, 06-6
	const decimalPatterns = [
		/^(\d{1,2})\.(\d{1,2})$/, // 06.6
		/^(\d{1,2})-(\d{1,2})$/, // 06-6
	];

	for (const pattern of decimalPatterns) {
		const match = cleaned.match(pattern);
		if (match) {
			const [, major, minor] = match;
			return `${major.padStart(2, "0")}.${minor}`;
		}
	}

	// Integer phase: 06, 6
	const intMatch = cleaned.match(/^(\d{1,2})$/);
	if (intMatch) {
		return intMatch[1].padStart(2, "0");
	}

	return null;
}

// ============================================================================
// Path Extraction (exported for testing)
// ============================================================================

/**
 * Extract plan reference from a file path
 */
export function extractPlanRefFromPath(path: string): string | null {
	const filename = basename(path);
	const match = filename.match(/^(\d{2}(?:\.\d+)?-\d{2})-PLAN\.md$/);
	return match ? match[1] : null;
}

/**
 * Extract phase ID from a directory path
 */
export function extractPhaseIdFromPath(path: string): string | null {
	const name = basename(path);
	const match = name.match(/^(\d{2}\.\d+)-/);
	return match ? match[1] : null;
}

// ============================================================================
// Internal Resolution
// ============================================================================

function resolvePlanRef(input: string, phasesDir: string): ResolvedPlan | null {
	// Try extracting from path first
	const pathRef = extractPlanRefFromPath(input);
	if (pathRef) {
		const normalized = normalizePlanRef(pathRef);
		if (normalized) {
			return resolveNormalizedPlanRef(normalized, phasesDir);
		}
	}

	// Try normalizing as plan ref
	const normalized = normalizePlanRef(input);
	if (normalized) {
		return resolveNormalizedPlanRef(normalized, phasesDir);
	}

	return null;
}

function resolveNormalizedPlanRef(
	ref: string,
	phasesDir: string,
): ResolvedPlan | null {
	// Try decimal phase format (e.g., 06.6-25)
	const decimalMatch = ref.match(/^(\d{2}\.\d+)-(\d{2})$/);
	if (decimalMatch) {
		const [, phaseId, planNumStr] = decimalMatch;
		const planNumber = parseInt(planNumStr, 10);

		if (!existsSync(phasesDir)) return null;

		const dirs = readdirSync(phasesDir);
		const phaseDir = dirs.find((d) => d.startsWith(`${phaseId}-`));
		if (!phaseDir) return null;

		const planPath = join(phasesDir, phaseDir, `${ref}-PLAN.md`);
		if (!existsSync(planPath)) return null;

		return {
			type: "plan",
			canonical: ref,
			path: planPath,
			phaseId,
			planNumber,
		};
	}

	// Try integer phase format (e.g., 08-14, 11-17)
	const intMatch = ref.match(/^(\d{2})-(\d{2})$/);
	if (intMatch) {
		const [, phaseId, planNumStr] = intMatch;
		const planNumber = parseInt(planNumStr, 10);

		if (!existsSync(phasesDir)) return null;

		const dirs = readdirSync(phasesDir);
		const phaseDir = dirs.find((d) => d.startsWith(`${phaseId}-`));
		if (!phaseDir) return null;

		const planPath = join(phasesDir, phaseDir, `${ref}-PLAN.md`);
		if (!existsSync(planPath)) return null;

		return {
			type: "plan",
			canonical: ref,
			path: planPath,
			phaseId,
			planNumber,
		};
	}

	return null;
}

function resolvePhaseId(
	input: string,
	phasesDir: string,
): ResolvedPhase | null {
	// Try extracting from path
	const pathId = extractPhaseIdFromPath(input);
	if (pathId) {
		return resolveNormalizedPhaseId(pathId, phasesDir);
	}

	// Try normalizing as phase ID
	const normalized = normalizePhaseId(input);
	if (normalized) {
		return resolveNormalizedPhaseId(normalized, phasesDir);
	}

	return null;
}

function resolveNormalizedPhaseId(
	id: string,
	phasesDir: string,
): ResolvedPhase | null {
	if (!existsSync(phasesDir)) return null;

	const dirs = readdirSync(phasesDir);
	const phaseDir = dirs.find((d) => d.startsWith(`${id}-`));
	if (!phaseDir) return null;

	return {
		type: "phase",
		canonical: id,
		path: join(phasesDir, phaseDir),
		dir: phaseDir,
	};
}

// ============================================================================
// Backwards Compatibility (deprecated, use resolveRef)
// ============================================================================

/** @deprecated Use resolveRef instead */
export const smartResolve = resolveRef;
