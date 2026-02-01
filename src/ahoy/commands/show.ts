/**
 * Show command - Display draft contents
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
	exitDraftNotFound,
	exitValidationError,
	findDraft,
	getDraftName,
	safeReadDir,
	safeReadFile,
	validateDraftName,
} from "../utils/drafts.js";

interface DraftDetails {
	name: string;
	path: string;
	files: string[];
	scope?: string;
}

export function registerShowCommand(program: Command): void {
	program
		.command("show <draft>")
		.description("Display draft contents")
		.option("--json", "Output as JSON")
		.action((draft: string, options: { json?: boolean }) => {
			const jsonMode = options.json ?? false;

			// Validate draft name
			const validation = validateDraftName(draft);
			if (!validation.valid) {
				exitValidationError(validation.error!, jsonMode);
			}

			const cwd = process.cwd();
			let draftPath: string | null;

			try {
				draftPath = findDraft(draft, cwd);
			} catch (error) {
				exitValidationError((error as Error).message, jsonMode);
			}

			if (!draftPath) {
				exitDraftNotFound(draft, jsonMode);
			}

			const files = safeReadDir(draftPath);
			const draftName = getDraftName(draftPath, draft);

			// Read scope.md if exists
			const scopePath = join(draftPath, "scope.md");
			const scope = existsSync(scopePath) ? safeReadFile(scopePath) : undefined;

			if (jsonMode) {
				const details: DraftDetails = {
					name: draftName,
					path: draftPath,
					files,
					...(scope && { scope }),
				};
				console.log(JSON.stringify(details, null, 2));
				return;
			}

			console.log(`Draft: ${draftName}\n`);
			console.log("Files:");
			for (const f of files) {
				console.log(`  ${f}`);
			}

			if (scope) {
				console.log("\n--- scope.md ---\n");
				console.log(scope);
			}
		});
}
