/**
 * Shell utilities for safe command execution
 */

/**
 * Escape shell special characters in an argument for use in double-quoted strings
 *
 * Escapes characters that have special meaning in double-quoted strings:
 * - Backticks (`) - command substitution
 * - Dollar signs ($) - variable expansion
 * - Backslashes (\) - escape character
 * - Double quotes (") - string delimiter
 *
 * @param arg - The argument to escape
 * @returns The escaped argument safe for use in double-quoted strings
 *
 * @example
 * ```ts
 * const title = "Fix `tiller verify` command";
 * const escaped = escapeShellArg(title);
 * // Result: "Fix \\`tiller verify\\` command"
 * execSync(`bd create --title="${escaped}"`);
 * ```
 */
export function escapeShellArg(arg: string): string {
	// Escape backticks, dollar signs, backslashes, and double quotes
	// Order matters: escape backslashes first, then other characters
	return arg.replace(/\\/g, "\\\\").replace(/([`$"])/g, "\\$1");
}
