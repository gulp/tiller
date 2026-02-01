/**
 * Verification check runner
 *
 * Parses PLAN.md <verification> section and runs checks
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
	extractHtmlTag,
	extractListItemsWithCode,
} from "../markdown/parser.js";
import type { VerificationCheck } from "../types/index.js";

const execAsync = promisify(exec);

/**
 * Parsed verification check with command and description
 */
export interface ParsedCheck {
	command: string | null; // Executable command (from backticks), or null if manual
	description: string; // Full description text
}

/**
 * Parse <verification> section from PLAN.md content
 * Extracts markdown checklist items: "- [ ] `command` description"
 * Commands in backticks are executable; items without backticks are manual checks.
 */
export function parseVerificationSection(planContent: string): string[] {
	const parsed = parseVerificationSectionFull(planContent);
	// Return descriptions for backward compatibility
	return parsed.map((p) => p.description);
}

/**
 * Parse verification section with full detail (command + description)
 */
export function parseVerificationSectionFull(
	planContent: string,
): ParsedCheck[] {
	// Use AST-based extraction (excludes code blocks structurally)
	const section = extractHtmlTag(planContent, "verification");
	if (!section) {
		return [];
	}

	// Parse list items using AST (preserves inline code with backticks)
	const items = extractListItemsWithCode(section);

	return items.map((text) => {
		// Extract command from backticks ONLY if at start of check (after optional checkbox)
		// `tsc --noEmit` passes → command
		// No `Track` imports → not a command (backticks mid-sentence)
		const cmdMatch = text.match(/^(?:- \[[ x]\] )?`([^`]+)`/);
		return {
			command: cmdMatch ? cmdMatch[1] : null,
			description: text,
		};
	});
}

/**
 * Run verification checks (uses parsed commands from backticks)
 */
export async function runVerificationChecks(
	checks: string[],
	options?: { timeout?: number; cwd?: string },
): Promise<VerificationCheck[]> {
	const timeout = options?.timeout ?? 60000; // 60 seconds default
	const cwd = options?.cwd ?? process.cwd();
	const results: VerificationCheck[] = [];

	for (const check of checks) {
		// Extract command from backticks, or skip if none
		const cmdMatch = check.match(/`([^`]+)`/);
		let command = cmdMatch ? cmdMatch[1] : null;

		// Commands with <placeholders> are templates, not executable
		const hasPlaceholder = command && /<[^>]+>/.test(command);

		// Config values (key: value) are not commands
		const isConfigValue = command && /^[a-z-]+:\s/.test(command);

		if (hasPlaceholder || isConfigValue) {
			command = null;
		}

		const result: VerificationCheck = {
			name: check,
			command: command || "(manual)",
			status: command ? "fail" : "skip",
			ran_at: new Date().toISOString(),
		};

		// Skip manual checks (no backtick command, placeholders, or config values)
		if (!command) {
			result.output = hasPlaceholder
				? "Template command with placeholders - manual verification required"
				: isConfigValue
					? "Config value reference - manual verification required"
					: "Manual check - no executable command";
			results.push(result);
			continue;
		}

		try {
			const { stdout, stderr } = await execAsync(command, {
				timeout,
				cwd,
				maxBuffer: 1024 * 1024, // 1MB
			});

			result.status = "pass";
			result.output = truncateOutput(stdout + stderr);
		} catch (error: unknown) {
			result.status = "fail";

			if (error instanceof Error && "stdout" in error && "stderr" in error) {
				const execError = error as { stdout: string; stderr: string };
				result.output = truncateOutput(execError.stdout + execError.stderr);
			} else if (error instanceof Error) {
				result.output = truncateOutput(error.message);
			}
		}

		results.push(result);
	}

	return results;
}

/**
 * Truncate output to 500 characters
 */
function truncateOutput(output: string): string {
	const clean = output.trim();
	if (clean.length <= 500) {
		return clean;
	}
	return `${clean.slice(0, 497)}...`;
}

/**
 * Get overall status from checks
 * - pass: all executable checks passed
 * - fail: any executable check failed
 * - skipped checks don't affect outcome
 */
export function getOverallStatus(checks: VerificationCheck[]): "pass" | "fail" {
	if (checks.length === 0) return "pass";
	const executable = checks.filter((c) => c.status !== "skip");
	if (executable.length === 0) return "pass"; // All skipped = manual verification needed
	return executable.every((c) => c.status === "pass") ? "pass" : "fail";
}

/**
 * Check if plan content has a <verification> section (even if empty)
 */
export function hasVerificationSection(planContent: string): boolean {
	return extractHtmlTag(planContent, "verification") !== null;
}
