/**
 * Number command - Assign sequential ID to draft
 *
 * Renames specs/foo/ → specs/0001-foo/
 */

import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

/**
 * Get next available draft number
 */
function getNextNumber(cwd: string): number {
	const specsDir = join(cwd, "specs");
	if (!existsSync(specsDir)) return 1;

	const entries = readdirSync(specsDir);
	let max = 0;

	for (const entry of entries) {
		const match = entry.match(/^(\d{4})-/);
		if (match) {
			const num = parseInt(match[1], 10);
			if (num > max) max = num;
		}
	}

	return max + 1;
}

export function registerNumberCommand(program: Command): void {
	program
		.command("number <draft>")
		.description("Assign sequential ID to draft")
		.action((draft: string) => {
			const cwd = process.cwd();
			const specsDir = join(cwd, "specs");
			const draftPath = join(specsDir, draft);

			// Validate draft exists
			if (!existsSync(draftPath)) {
				console.error(`Draft not found: ${draft}`);
				process.exit(1);
			}

			// Check if already numbered
			if (/^\d{4}-/.test(draft)) {
				console.error(`Draft already numbered: ${draft}`);
				process.exit(1);
			}

			// Check if locked
			if (draft.endsWith(".lock")) {
				console.error(`Cannot number locked draft: ${draft}`);
				process.exit(1);
			}

			// Get next number and rename
			const nextNum = getNextNumber(cwd);
			const paddedNum = nextNum.toString().padStart(4, "0");
			const newName = `${paddedNum}-${draft}`;
			const newPath = join(specsDir, newName);

			renameSync(draftPath, newPath);

			console.log(`Numbered: ${draft} → ${newName}`);
			console.log(`\nNext: ahoy lock ${newName}`);
		});
}
