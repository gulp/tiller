/**
 * Scope command - Read/write scope.md
 *
 * Read mode: Display scope.md content
 * Write mode: Write scope.md from stdin or argument
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
	exitDraftNotFound,
	exitFsError,
	exitValidationError,
	findDraft,
	getDraftName,
	safeReadFile,
	validateContent,
	validateDraftName,
} from "../utils/drafts.js";

export function registerScopeCommand(program: Command): void {
	program
		.command("scope <draft> [content]")
		.description("Read/write scope.md (use --write with content or stdin)")
		.option("--json", "Output as JSON")
		.option("--write", "Write scope.md (reads from argument or stdin)")
		.action(
			async (
				draft: string,
				content: string | undefined,
				options: { json?: boolean; write?: boolean },
			) => {
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

				const scopePath = join(draftPath, "scope.md");
				const draftName = getDraftName(draftPath, draft);

				// Write mode
				if (options.write) {
					let scopeContent = content;

					// If no content argument, read from stdin
					if (!scopeContent) {
						const stdin = process.stdin;
						stdin.setEncoding("utf8");

						if (stdin.isTTY) {
							exitValidationError(
								"--write requires content via argument or stdin. Usage: ahoy scope <draft> \"content\" --write, or: echo 'content' | ahoy scope <draft> --write",
								jsonMode,
							);
						}

						// Read stdin with error handling
						const chunks: string[] = [];
						try {
							for await (const chunk of stdin) {
								chunks.push(chunk);
							}
						} catch (error) {
							exitValidationError(
								`Error reading stdin: ${(error as Error).message}`,
								jsonMode,
							);
						}
						scopeContent = chunks.join("");
					}

					// Validate content before writing
					const contentValidation = validateContent(scopeContent, "scope.md");
					if (!contentValidation.valid) {
						exitValidationError(contentValidation.error!, jsonMode);
					}

					try {
						writeFileSync(scopePath, scopeContent);
					} catch (error) {
						exitFsError(
							"write scope.md",
							scopePath,
							error as NodeJS.ErrnoException,
							jsonMode,
						);
					}

					if (jsonMode) {
						console.log(
							JSON.stringify(
								{
									written: scopePath,
									draft: draftName,
									size: scopeContent.length,
								},
								null,
								2,
							),
						);
					} else {
						console.log(`Written: ${scopePath}`);
						console.log(`Size: ${scopeContent.length} chars`);
					}
					return;
				}

				// Read mode
				if (!existsSync(scopePath)) {
					if (jsonMode) {
						console.log(
							JSON.stringify(
								{
									error: "scope.md not found",
									draft: draftName,
									path: scopePath,
									hint: `Create one with: ahoy discuss ${draft}`,
								},
								null,
								2,
							),
						);
					} else {
						console.error(`scope.md not found for ${draftName}`);
						console.error(`\nCreate one with: ahoy discuss ${draft}`);
					}
					process.exit(1);
				}

				const scopeContent = safeReadFile(scopePath);

				if (!scopeContent) {
					exitValidationError(
						`Could not read scope.md for ${draftName}`,
						jsonMode,
					);
				}

				if (jsonMode) {
					console.log(
						JSON.stringify(
							{
								draft: draftName,
								path: scopePath,
								content: scopeContent,
							},
							null,
							2,
						),
					);
				} else {
					console.log(scopeContent);
				}
			},
		);
}
