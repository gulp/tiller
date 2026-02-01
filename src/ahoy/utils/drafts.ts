/**
 * Shared draft utilities for ahoy CLI commands
 *
 * Centralizes draft discovery, validation, and error handling.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Draft lifecycle state
 */
export type DraftLifecycleState = "drafting" | "numbered" | "locked";

/**
 * Base draft state shared across commands
 */
export interface BaseDraftState {
	name: string;
	path: string;
	state: DraftLifecycleState;
	files: string[];
}

/**
 * Result of draft name validation
 */
export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Validate draft name to prevent path traversal attacks
 */
export function validateDraftName(name: string): ValidationResult {
	if (!name || name.trim().length === 0) {
		return { valid: false, error: "Draft name cannot be empty" };
	}

	if (name.includes("/") || name.includes("\\")) {
		return {
			valid: false,
			error: "Draft name cannot contain path separators",
		};
	}

	if (name.includes("..")) {
		return {
			valid: false,
			error: "Draft name cannot contain '..'",
		};
	}

	if (name.startsWith(".")) {
		return {
			valid: false,
			error: "Draft name cannot start with '.'",
		};
	}

	return { valid: true };
}

/**
 * Validate content before writing to prevent accidental data loss
 */
export function validateContent(
	content: string,
	filename: string,
): ValidationResult {
	if (!content || content.trim().length === 0) {
		return {
			valid: false,
			error: `Refusing to write empty ${filename}. Content must not be empty.`,
		};
	}

	return { valid: true };
}

/**
 * Classify draft state based on directory name
 */
export function classifyState(name: string): DraftLifecycleState {
	if (name.endsWith(".lock")) return "locked";
	if (/^\d{4}-/.test(name)) return "numbered";
	return "drafting";
}

/**
 * Find draft by name (handles numbered/locked variants)
 *
 * @returns Path to draft directory, or null if not found
 * @throws Error if specs directory exists but cannot be read
 */
export function findDraft(name: string, cwd: string): string | null {
	const specsDir = join(cwd, "specs");

	if (!existsSync(specsDir)) {
		return null;
	}

	// Try exact match first
	const exact = join(specsDir, name);
	if (existsSync(exact)) return exact;

	// Try with .lock suffix
	const locked = join(specsDir, `${name}.lock`);
	if (existsSync(locked)) return locked;

	// Search for partial matches
	let entries: string[];
	try {
		entries = readdirSync(specsDir);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "EACCES") {
			throw new Error(`Cannot read specs directory: Permission denied`);
		}
		if (err.code === "ENOTDIR") {
			throw new Error(`specs is not a directory`);
		}
		throw new Error(`Cannot read specs directory: ${err.message}`);
	}

	const match = entries.find(
		(e) =>
			e === name ||
			e.replace(/\.lock$/, "") === name ||
			e.endsWith(`-${name}`) ||
			e.endsWith(`-${name}.lock`),
	);

	if (match) return join(specsDir, match);

	return null;
}

/**
 * Safe file read with error handling
 *
 * @returns File content or undefined if file doesn't exist or can't be read
 */
export function safeReadFile(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf-8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return undefined;
		}
		// Log other errors but don't crash
		console.error(
			`Warning: Could not read ${basename(filePath)}: ${err.message}`,
		);
		return undefined;
	}
}

/**
 * Safe directory listing with error handling
 *
 * @returns Array of entries or empty array on error
 */
export function safeReadDir(dirPath: string): string[] {
	try {
		return readdirSync(dirPath);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		console.error(`Warning: Could not read directory: ${err.message}`);
		return [];
	}
}

/**
 * Exit with standardized "draft not found" error
 */
export function exitDraftNotFound(draft: string, jsonMode: boolean): never {
	if (jsonMode) {
		console.log(
			JSON.stringify(
				{
					error: "Draft not found",
					draft,
					hint: `Create one with: ahoy draft ${draft}`,
				},
				null,
				2,
			),
		);
	} else {
		console.error(`Draft not found: ${draft}`);
		console.error(`\nCreate one with: ahoy draft ${draft}`);
	}
	process.exit(1);
}

/**
 * Exit with standardized validation error
 */
export function exitValidationError(error: string, jsonMode: boolean): never {
	if (jsonMode) {
		console.log(JSON.stringify({ error, type: "validation_error" }, null, 2));
	} else {
		console.error(`Error: ${error}`);
	}
	process.exit(1);
}

/**
 * Exit with standardized filesystem error
 */
export function exitFsError(
	operation: string,
	path: string,
	error: NodeJS.ErrnoException,
	jsonMode: boolean,
): never {
	let message = `Failed to ${operation}: ${error.message}`;

	if (error.code === "ENOSPC") {
		message = `Failed to ${operation}: Disk is full`;
	} else if (error.code === "EACCES") {
		message = `Failed to ${operation}: Permission denied`;
	} else if (error.code === "EROFS") {
		message = `Failed to ${operation}: Read-only filesystem`;
	}

	if (jsonMode) {
		console.log(
			JSON.stringify(
				{
					error: message,
					code: error.code,
					path,
					type: "fs_error",
				},
				null,
				2,
			),
		);
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

/**
 * Get draft name from path (using basename)
 */
export function getDraftName(draftPath: string, fallback?: string): string {
	return basename(draftPath) || fallback || "";
}
