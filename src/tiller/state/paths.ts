/**
 * Tiller path resolution - SINGLE SOURCE OF TRUTH
 *
 * This module contains the authoritative project root resolver.
 * All other modules must import from here to avoid circular dependencies.
 *
 * NO IMPORTS from other tiller modules allowed to prevent cycles.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Authoritative project root resolver.
 * Walk up from cwd: existing .tiller/ > .git/ > cwd
 *
 * This is the SINGLE source of truth for project root.
 * All other modules must import this function.
 */
export function findProjectRoot(): string {
	let dir = process.cwd();
	const root = dirname(dir);

	// Walk up looking for .tiller/ or .git/
	while (dir !== root) {
		// Prefer existing .tiller/ directory
		if (existsSync(join(dir, ".tiller"))) {
			return dir;
		}
		// Fall back to git root
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		dir = dirname(dir);
	}

	// Check root directory too
	if (existsSync(join(dir, ".tiller")) || existsSync(join(dir, ".git"))) {
		return dir;
	}

	// Default to cwd if no markers found
	return process.cwd();
}

// Computed once at module load
const PROJECT_ROOT = findProjectRoot();

/** The canonical name of the tiller directory. Use this when constructing paths for other worktrees. */
export const TILLER_DIR_NAME = ".tiller";

const LOCAL_TILLER_DIR = join(PROJECT_ROOT, TILLER_DIR_NAME);

/**
 * Resolve the actual tiller directory, following redirects if present.
 * A redirect file (.tiller/redirect) contains the path to the main repo's .tiller/
 */
function resolveTillerDir(): { dir: string; isRedirect: boolean; redirectTarget: string | null } {
	const redirectPath = join(LOCAL_TILLER_DIR, "redirect");

	if (existsSync(redirectPath)) {
		try {
			const targetPath = readFileSync(redirectPath, "utf-8").trim();
			// Resolve relative to the local .tiller/ directory
			const resolvedTarget = isAbsolute(targetPath)
				? targetPath
				: resolve(LOCAL_TILLER_DIR, targetPath);

			// Validate target exists
			if (existsSync(resolvedTarget)) {
				return {
					dir: resolvedTarget,
					isRedirect: true,
					redirectTarget: targetPath
				};
			}
			// Invalid redirect - log warning but continue with local
			console.warn(`Warning: .tiller/redirect points to non-existent path: ${resolvedTarget}`);
		} catch (e) {
			// Can't read redirect file - use local
			console.warn(`Warning: Could not read .tiller/redirect: ${(e as Error).message}`);
		}
	}

	return { dir: LOCAL_TILLER_DIR, isRedirect: false, redirectTarget: null };
}

// Resolve redirect at module load
const RESOLVED_TILLER = resolveTillerDir();
const TILLER_DIR = RESOLVED_TILLER.dir;

/**
 * Core paths - computed from project root, following redirects.
 * Re-exported by config.ts with additional paths.
 */
export const CORE_PATHS = {
	PROJECT_ROOT,
	TILLER_DIR,
	LOCAL_TILLER_DIR,  // The local .tiller/ (may contain redirect)
	RUNS_DIR: join(TILLER_DIR, "runs"),
	LEGACY_TRACKS_DIR: join(TILLER_DIR, "tracks"),
	IS_REDIRECT: RESOLVED_TILLER.isRedirect,
	REDIRECT_TARGET: RESOLVED_TILLER.redirectTarget,
} as const;

/**
 * Guard against nested .tiller/ directories.
 * Aborts if .tiller/ would be created inside an existing .tiller/ tree.
 */
export function guardNestedTiller(): void {
	const cwd = process.cwd();

	// Check if we're inside an existing .tiller directory
	if (cwd.includes("/.tiller/") || cwd.endsWith("/.tiller")) {
		console.error(
			"ERROR: Cannot create .tiller/ inside another .tiller/ directory",
		);
		console.error(`  cwd: ${cwd}`);
		console.error(`  project root: ${PROJECT_ROOT}`);
		process.exit(2);
	}

	// Note: TILLER_DIR may differ from LOCAL_TILLER_DIR when using redirects
	// This is expected behavior for worktrees sharing main repo's .tiller/
}

/**
 * Normalize a path to be relative from project root.
 * Enables portability across machines and worktrees.
 *
 * @param inputPath - Absolute or relative path
 * @returns Relative path from project root (uses forward slashes)
 */
export function normalizePlanPath(inputPath: string): string {
	if (!inputPath) return inputPath;

	// If already relative, return as-is
	if (!isAbsolute(inputPath)) {
		return inputPath;
	}

	// Convert absolute to relative from project root
	const relativePath = relative(PROJECT_ROOT, inputPath);

	// If the path is outside project root (starts with ..), keep absolute
	if (relativePath.startsWith("..")) {
		return inputPath;
	}

	return relativePath;
}

/**
 * Resolve a plan path to absolute for file operations.
 *
 * @param storedPath - Path as stored in run (may be relative or absolute)
 * @returns Absolute path resolved from project root
 */
export function resolvePlanPath(storedPath: string): string {
	if (!storedPath) return storedPath;

	if (isAbsolute(storedPath)) {
		return storedPath;
	}

	return join(PROJECT_ROOT, storedPath);
}

/**
 * Check if a plan file exists, resolving relative paths.
 * Use this instead of existsSync(run.plan_path) directly.
 *
 * @param planPath - Path as stored in run (may be relative or absolute)
 * @returns true if the plan file exists
 */
export function planExists(planPath: string): boolean {
	if (!planPath) return false;
	return existsSync(resolvePlanPath(planPath));
}

/**
 * Read a plan file, resolving relative paths.
 * Use this instead of readFileSync(run.plan_path) directly.
 *
 * @param planPath - Path as stored in run (may be relative or absolute)
 * @returns File contents as UTF-8 string
 * @throws Error if file doesn't exist
 */
export function readPlanFile(planPath: string): string {
	return readFileSync(resolvePlanPath(planPath), "utf-8");
}

/**
 * Get redirect info for display in tiller status.
 */
export function getTillerRedirectInfo(): {
	isRedirect: boolean;
	localDir: string;
	targetDir: string;
	redirectTarget: string | null;
} {
	return {
		isRedirect: RESOLVED_TILLER.isRedirect,
		localDir: LOCAL_TILLER_DIR,
		targetDir: TILLER_DIR,
		redirectTarget: RESOLVED_TILLER.redirectTarget,
	};
}

/**
 * Create a redirect file in the local .tiller/ directory.
 * Used when setting up a worktree to share state with main repo.
 *
 * @param targetPath - Path to the main repo's .tiller/ (relative or absolute)
 * @throws Error if target doesn't exist or isn't a valid tiller directory
 */
export function createTillerRedirect(targetPath: string): void {
	// Resolve target path
	const resolvedTarget = isAbsolute(targetPath)
		? targetPath
		: resolve(LOCAL_TILLER_DIR, targetPath);

	// Validate target exists
	if (!existsSync(resolvedTarget)) {
		throw new Error(`Redirect target does not exist: ${resolvedTarget}`);
	}

	// Validate it's a tiller directory (has runs/ subdirectory or config)
	const hasRuns = existsSync(join(resolvedTarget, "runs"));
	const hasConfig = existsSync(join(resolvedTarget, "config.json")) ||
		existsSync(join(resolvedTarget, "tiller.toml"));

	if (!hasRuns && !hasConfig) {
		throw new Error(`Target is not a valid tiller directory: ${resolvedTarget}`);
	}

	// Create local .tiller/ if needed
	if (!existsSync(LOCAL_TILLER_DIR)) {
		mkdirSync(LOCAL_TILLER_DIR, { recursive: true });
	}

	// Write redirect file with the original path (preserve relative if given)
	const redirectPath = join(LOCAL_TILLER_DIR, "redirect");
	writeFileSync(redirectPath, targetPath + "\n");
}
