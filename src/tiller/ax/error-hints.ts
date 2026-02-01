/**
 * AX Error Hints - Helpful hints for common agent CLI mistakes
 *
 * When agents try common CLI patterns that don't exist, provide helpful
 * hints instead of dead-end errors.
 */

import type { Command } from "commander";

// Pattern → Hint mapping for common agent mistakes
const ERROR_HINTS: Array<{ pattern: RegExp; hint: string }> = [
	// Flags that should be positional
	{
		pattern: /unknown option.*--phase/i,
		hint: "Use positional arg: tiller <cmd> <phase-ref> (e.g., tiller verify 06.6-01)",
	},
	{
		pattern: /unknown option.*--plan/i,
		hint: "Use positional arg: tiller <cmd> <plan-ref> (e.g., tiller show 06.6-01)",
	},
	{
		pattern: /unknown option.*--ref/i,
		hint: "Use positional arg: tiller <cmd> <ref> (e.g., tiller activate 06.6-01)",
	},

	// Flags that exist on different commands
	{
		pattern: /unknown option.*--description/i,
		hint: "Set after creation: tiller plan set <ref> description \"...\"",
	},

	// Common typos
	{
		pattern: /unknown option.*--dryrun/i,
		hint: "Use --dry-run (with hyphen)",
	},
	{
		pattern: /unknown option.*--no-confirm/i,
		hint: "Use --confirm=false or environment variable",
	},
];

/**
 * Configure Commander to show helpful hints on errors
 */
export function configureAXErrors(program: Command): void {
	const originalOutputError = program.configureOutput().outputError;

	program.configureOutput({
		outputError: (str: string, write: (s: string) => void) => {
			// Write the original error
			if (originalOutputError) {
				originalOutputError(str, write);
			} else {
				write(str);
			}

			// Check for matching hints
			for (const { pattern, hint } of ERROR_HINTS) {
				if (pattern.test(str)) {
					write(`→ Hint: ${hint}\n`);
					return;
				}
			}
		},
	});
}
