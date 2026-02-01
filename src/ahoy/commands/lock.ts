/**
 * Lock command - Commit draft to supply-side
 *
 * Renames specs/0001-foo/ → specs/0001-foo.lock/
 */

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

export function registerLockCommand(program: Command): void {
	program
		.command("lock <draft>")
		.description("Commit draft (add .lock suffix)")
		.action((draft: string) => {
			const cwd = process.cwd();
			const specsDir = join(cwd, "specs");
			const draftPath = join(specsDir, draft);

			// Validate draft exists
			if (!existsSync(draftPath)) {
				console.error(`Draft not found: ${draft}`);
				process.exit(1);
			}

			// Check if already locked
			if (draft.endsWith(".lock")) {
				console.error(`Draft already locked: ${draft}`);
				process.exit(1);
			}

			// Warn if not numbered
			if (!/^\d{4}-/.test(draft)) {
				console.warn(
					`Warning: Locking unnumbered draft. Consider 'ahoy number ${draft}' first.`,
				);
			}

			// Add .lock suffix
			const lockedName = `${draft}.lock`;
			const lockedPath = join(specsDir, lockedName);

			renameSync(draftPath, lockedPath);

			console.log(`Locked: ${draft} → ${lockedName}`);
			console.log(
				`\nDraft is now committed. Use 'tiller accept ${draft}' to import.`,
			);
		});
}
