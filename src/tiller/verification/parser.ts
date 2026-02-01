/**
 * PLAN.md verification parser (prose-first, YAML as escape hatch)
 *
 * Supports three formats:
 *
 * 1. Checkbox (trackable pass/fail checklist):
 * ```markdown
 * <verification>
 * - [ ] `tsc --noEmit` passes
 * - [ ] `bun run test` passes
 * - [ ] Manual acceptance criteria
 * </verification>
 * ```
 * - Backtick commands become auto-runnable `cmd` checks
 * - Non-backtick items become `manual` checks
 * - The `- [ ]` pattern implies execution tracking
 *
 * 2. Prose (agent-interpreted outcomes):
 * ```markdown
 * <verification>
 * - `tiller phase insert 06 "test"` creates phase 07
 * - Existing phase 07 renamed to 08
 * - ROADMAP.md updated correctly
 * </verification>
 * ```
 * - ALL items become `manual` checks (agent-interpreted)
 * - Backticks are context, not auto-run instructions
 * - Agent must verify stated outcomes, not just run commands
 *
 * 3. YAML (--ci mode, machine-deterministic):
 * ```yaml
 * <verification>
 * - name: type_check
 *   cmd: tsc --noEmit
 * - name: tests
 *   cmd: bun test
 *   timeout: 300
 * - name: uat_review
 *   manual: true
 * </verification>
 * ```
 *
 * Detection order: YAML (has name:/cmd:) → Checkbox (has - [ ]) → Prose
 */

import { load as parseYaml } from "js-yaml";
import { extractHtmlTag } from "../markdown/parser.js";
import type { VerificationCheckDef } from "../types/index.js";

export type VerificationFormat = "prose" | "yaml" | "checkbox" | "empty";

export interface ParseResult {
	success: boolean;
	format: VerificationFormat;
	checks: VerificationCheckDef[];
	errors: string[];
}

/**
 * Parse <verification> section from PLAN.md content.
 *
 * Detects format and returns structured check definitions:
 * - YAML: structured check definitions with cmd/manual/timeout
 * - Checkbox: backticks = cmd, else manual (trackable checklist)
 * - Prose: all manual (agent-interpreted outcomes)
 */
export function parseVerification(planContent: string): ParseResult {
	// Extract content between <verification> tags
	const section = extractHtmlTag(planContent, "verification");
	if (!section) {
		return { success: true, format: "empty", checks: [], errors: [] };
	}

	const trimmedSection = section.trim();

	// Detection order: YAML → Checkbox → Prose

	// 1. YAML: has `name:` or `cmd:` keys
	const isYamlFormat =
		trimmedSection.startsWith("-") &&
		(trimmedSection.includes("name:") || trimmedSection.includes("cmd:"));

	if (isYamlFormat) {
		return parseYamlFormat(section);
	}

	// 2. Checkbox: has `- [ ]` or `- [x]` patterns
	if (hasCheckboxFormat(section)) {
		return parseCheckboxFormat(section);
	}

	// 3. Prose: default (agent-interpreted)
	return parseProseFormat(section);
}

/**
 * Detect if verification section uses checkbox format.
 * Checkbox format has `- [ ]` or `- [x]` patterns indicating trackable state.
 */
export function hasCheckboxFormat(section: string): boolean {
	return /^[-*]\s*\[[ x]\]/im.test(section);
}

/**
 * Parse checkbox verification section (trackable pass/fail checklist).
 * - Backtick commands at start of line become auto-runnable `cmd` checks
 * - Non-backtick items become `manual` checks
 */
function parseCheckboxFormat(section: string): ParseResult {
	const checks: VerificationCheckDef[] = [];
	const lines = section.split("\n");

	let checkIndex = 0;
	for (const line of lines) {
		const trimmed = line.trim();

		// Match checkbox bullet points: "- [ ] content" or "- [x] content"
		const checkboxMatch = trimmed.match(/^[-*]\s*\[[ x]\]\s*(.+)$/i);
		if (!checkboxMatch) continue;

		const description = checkboxMatch[1].trim();
		if (!description) continue;

		checkIndex++;
		const name = `check_${checkIndex.toString().padStart(3, "0")}`;

		// Detect backtick command at start: `cmd` ...
		const cmdMatch = description.match(/^`([^`]+)`/);
		if (cmdMatch) {
			// Backtick command = auto-runnable
			checks.push({
				name,
				cmd: cmdMatch[1],
				description,
			});
		} else {
			// No backtick = manual check
			checks.push({
				name,
				manual: true,
				description,
			});
		}
	}

	return {
		success: true,
		format: "checkbox",
		checks,
		errors: [],
	};
}

/**
 * Parse prose verification section (bullet points for agent interpretation).
 */
function parseProseFormat(section: string): ParseResult {
	const checks: VerificationCheckDef[] = [];
	const lines = section.split("\n");

	let checkIndex = 0;
	for (const line of lines) {
		const trimmed = line.trim();

		// Match bullet points: "- ", "- [ ]", "- [x]", "* "
		const bulletMatch = trimmed.match(/^[-*]\s*(?:\[[ x]\])?\s*(.+)$/i);
		if (!bulletMatch) continue;

		const description = bulletMatch[1].trim();
		if (!description) continue;

		checkIndex++;

		// Generate name from description (slugified, first 40 chars)
		const name = `check_${checkIndex.toString().padStart(3, "0")}`;

		checks.push({
			name,
			manual: true, // prose checks are agent-interpreted
			description,
		});
	}

	return {
		success: true,
		format: "prose",
		checks,
		errors: [],
	};
}

/**
 * Parse YAML verification section (structured check definitions).
 */
function parseYamlFormat(section: string): ParseResult {
	const errors: string[] = [];
	const checks: VerificationCheckDef[] = [];

	// Parse as YAML
	let parsed: unknown;
	try {
		parsed = parseYaml(section);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			success: false,
			format: "yaml",
			checks: [],
			errors: [`Invalid YAML syntax: ${message}`],
		};
	}

	// Validate parsed structure is an array
	if (!Array.isArray(parsed)) {
		return {
			success: false,
			format: "yaml",
			checks: [],
			errors: ["Verification section must be a YAML array"],
		};
	}

	// Track seen names for duplicate detection
	const seenNames = new Set<string>();

	// Validate each item
	for (let i = 0; i < parsed.length; i++) {
		const item = parsed[i];

		// Must be an object
		if (typeof item !== "object" || item === null) {
			errors.push(`Item ${i + 1}: must be an object`);
			continue;
		}

		const obj = item as Record<string, unknown>;

		// name is required
		if (!obj.name || typeof obj.name !== "string") {
			errors.push(`Item ${i + 1}: missing required 'name' field`);
			continue;
		}

		const name = obj.name;

		// Check for duplicates
		if (seenNames.has(name)) {
			errors.push(`Item ${i + 1}: duplicate name '${name}'`);
			continue;
		}
		seenNames.add(name);

		// Check mutual exclusivity of cmd and manual
		const hasCmd = "cmd" in obj && obj.cmd !== undefined;
		const hasManual = "manual" in obj && obj.manual !== undefined;

		if (hasCmd && hasManual) {
			errors.push(
				`Item '${name}': cannot have both 'cmd' and 'manual' (mutually exclusive)`,
			);
			continue;
		}

		// Validate cmd type
		if (hasCmd && typeof obj.cmd !== "string") {
			errors.push(`Item '${name}': 'cmd' must be a string`);
			continue;
		}

		// Validate manual type
		if (hasManual && typeof obj.manual !== "boolean") {
			errors.push(`Item '${name}': 'manual' must be a boolean`);
			continue;
		}

		// Validate timeout type and value
		if ("timeout" in obj && obj.timeout !== undefined) {
			if (typeof obj.timeout !== "number") {
				errors.push(`Item '${name}': 'timeout' must be a number`);
				continue;
			}
			if (obj.timeout <= 0) {
				errors.push(`Item '${name}': 'timeout' must be > 0`);
				continue;
			}
		}

		// Build check definition
		const checkDef: VerificationCheckDef = { name };

		if (hasCmd) {
			checkDef.cmd = obj.cmd as string;
		}

		if (hasManual) {
			checkDef.manual = obj.manual as boolean;
		}

		if (typeof obj.timeout === "number") {
			checkDef.timeout = obj.timeout;
		}

		checks.push(checkDef);
	}

	return {
		success: errors.length === 0,
		format: "yaml",
		checks: errors.length === 0 ? checks : [],
		errors,
	};
}

/**
 * Legacy function name for backward compatibility.
 * @deprecated Use parseVerification instead
 */
export function parseVerificationYaml(planContent: string): ParseResult {
	return parseVerification(planContent);
}

/**
 * Check if PLAN.md has a YAML-format <verification> section.
 */
export function hasYamlVerificationSection(planContent: string): boolean {
	const section = extractHtmlTag(planContent, "verification");
	if (!section) return false;

	const trimmed = section.trim();
	return (
		trimmed.startsWith("-") &&
		(trimmed.includes("name:") || trimmed.includes("cmd:"))
	);
}
