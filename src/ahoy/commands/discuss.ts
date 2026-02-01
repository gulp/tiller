/**
 * Discuss command - Gather vision for a draft via AskUserQuestion
 *
 * CLI role: Output TOON state (deterministic)
 * Agent role: Execute discussion workflow (inference)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { outputTOON } from "../../tiller/types/toon.js";
import {
	classifyState,
	exitDraftNotFound,
	exitValidationError,
	findDraft,
	getDraftName,
	safeReadDir,
	validateDraftName,
} from "../utils/drafts.js";

export function registerDiscussCommand(program: Command): void {
	program
		.command("discuss <draft>")
		.description("Gather vision for a draft via AskUserQuestion workflow")
		.option("--json", "Output as JSON")
		.option("--pretty", "Human-readable output")
		.action((draft: string, options: { json?: boolean; pretty?: boolean }) => {
			// Validate draft name
			const validation = validateDraftName(draft);
			if (!validation.valid) {
				exitValidationError(validation.error!, options.json ?? false);
			}

			const cwd = process.cwd();
			let draftPath: string | null;

			try {
				draftPath = findDraft(draft, cwd);
			} catch (error) {
				exitValidationError((error as Error).message, options.json ?? false);
			}

			if (!draftPath) {
				exitDraftNotFound(draft, options.json ?? false);
			}

			// Gather state
			const name = getDraftName(draftPath);
			const files = safeReadDir(draftPath);
			const scopePath = join(draftPath, "scope.md");
			const hasScope = existsSync(scopePath);
			const scopeContent = hasScope
				? readFileSync(scopePath, "utf-8")
				: undefined;

			// Build state data
			const discussData = {
				draft: name,
				state: classifyState(name),
				scope: {
					exists: hasScope,
					path: scopePath,
					...(scopeContent && { content: scopeContent }),
				},
				files,
				next: hasScope
					? ["Review scope.md with user", "ahoy number " + name]
					: ["Discuss vision with user", "Write scope.md"],
			};

			// JSON output
			if (options.json) {
				console.log(JSON.stringify(discussData, null, 2));
				return;
			}

			// Pretty output
			const printPretty = () => {
				console.log(`Draft: ${name}`);
				console.log(`State: ${classifyState(name)}`);
				console.log(`Scope: ${hasScope ? "exists" : "missing"}`);
				if (hasScope) {
					console.log(`\n--- scope.md ---\n${scopeContent}`);
				}
				console.log(
					`\nNext: ${hasScope ? "Review with user, then ahoy number" : "Discuss vision, write scope.md"}`,
				);
			};

			if (options.pretty) {
				printPretty();
				return;
			}

			// Default: TOON with agent_hint
			const hint = hasScope
				? `Scope exists. Review scope.md with user. If changes needed, update via Edit tool. When ready: ahoy number ${name}`
				: `Scope missing. Use AskUserQuestion to gather vision: 1) What should ${name} do? 2) What's essential? 3) What's NOT in v1? Then write scope.md.`;

			outputTOON(
				{ discuss: discussData },
				{
					agent_hint: hint,
					prettyFn: printPretty,
				},
			);
		});
}
