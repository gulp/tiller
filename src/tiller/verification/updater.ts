/**
 * PLAN.md checkbox updater
 * Updates verification checkboxes based on check execution results
 *
 * Uses AST-based parsing per ADR-0002 to correctly handle code blocks
 */

import { readFileSync, writeFileSync } from "node:fs";
import { extractHtmlTag } from "../markdown/parser.js";
import type { DerivedCheck } from "../types/index.js";

/**
 * Escapes special regex characters in a string
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Updates PLAN.md verification checkboxes based on check results.
 *
 * Rules:
 * - `- [ ]` → `- [x]` when check status is 'pass'
 * - `- [ ]` stays `- [ ]` when check fails or has error
 * - Manual checks are not modified (require human judgment)
 * - Idempotent: re-running updates based on latest results
 *
 * @param planPath - Absolute path to PLAN.md file
 * @param checks - Array of derived checks with execution results
 */
export function updatePlanCheckboxes(
	planPath: string,
	checks: DerivedCheck[],
): void {
	let content: string;

	// Read PLAN.md file
	try {
		content = readFileSync(planPath, "utf-8");
	} catch (err) {
		console.error(`Warning: failed to read ${planPath}: ${err}`);
		return;
	}

	// Extract <verification> section using AST parser (handles code blocks correctly)
	// extractHtmlTag returns the LAST match, which is the real section in plans with examples
	const verifySection = extractHtmlTag(content, "verification");
	if (!verifySection) {
		// No verification section - nothing to update
		return;
	}

	let updatedSection = verifySection;

	// Update checkboxes for passing cmd checks
	for (const check of checks) {
		// Skip manual checks - they require human judgment
		if (check.kind === "manual") continue;

		// Only update passing checks
		if (check.status !== "pass") continue;

		// Extract command from check name (handles legacy format where name = full description)
		// Legacy: "- [ ] `echo "pass"` should be checked after verify" → "echo \"pass\""
		// Event-sourced: "echo \"pass\"" → "echo \"pass\""
		const cmdMatch = check.name.match(/`([^`]+)`/);
		const commandName = cmdMatch ? cmdMatch[1] : check.name;
		const escapedCommand = escapeRegex(commandName);

		// Pattern matches: "- [ ] `command`" or "- [x] `command`" (with optional description after)
		// Captures: (opening "- [") + (space or x) + ("] `command`..." rest of line)
		const checkboxPattern = new RegExp(
			`^(\\s*- \\[)[ x](\\] \`${escapedCommand}\`.*?)$`,
			"gm",
		);

		// Replace [ ] or [x] with [x] (idempotent)
		updatedSection = updatedSection.replace(checkboxPattern, "$1x$2");
	}

	// If no changes were made, skip write
	if (updatedSection === verifySection) {
		return;
	}

	// Replace the LAST <verification> section in content (matches AST parser behavior)
	// Find last occurrence of the original section
	const lastOpenIdx = content.lastIndexOf("<verification>");
	const lastCloseIdx = content.lastIndexOf("</verification>");

	if (lastOpenIdx === -1 || lastCloseIdx === -1 || lastCloseIdx < lastOpenIdx) {
		console.error("Warning: could not locate verification section for replacement");
		return;
	}

	const updatedContent =
		content.slice(0, lastOpenIdx) +
		`<verification>\n${updatedSection}\n</verification>` +
		content.slice(lastCloseIdx + "</verification>".length);

	// Write back to file
	try {
		writeFileSync(planPath, updatedContent, "utf-8");
	} catch (err) {
		console.error(`Warning: failed to write ${planPath}: ${err}`);
	}
}
