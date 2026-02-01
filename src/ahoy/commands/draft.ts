/**
 * Draft command - Create unnumbered draft folder in specs/
 *
 * Per ADR-0005: Drafts are exploratory work.
 * Lifecycle: unnumbered → numbered → .lock
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

const SCOPE_TEMPLATE = `# {{NAME}} - Scope

<problem>
## Problem Statement

What problem does this solve?
</problem>

<desired_state>
## Desired State

What does success look like?
</desired_state>

<in_scope>
## In Scope

-
</in_scope>

<out_scope>
## Out of Scope

-
</out_scope>

<success_criteria>
## Success Criteria

- [ ]
</success_criteria>
`;

/**
 * Validate draft name
 * - No numeric prefix (would conflict with numbered drafts)
 * - Valid directory name
 */
function validateName(name: string): { valid: boolean; error?: string } {
	// Check for numeric prefix (like 0001-foo)
	if (/^\d+[-_]/.test(name)) {
		return {
			valid: false,
			error: `Name cannot start with numbers. Use 'ahoy number ${name.replace(/^\d+[-_]/, "")}' to assign an ID later.`,
		};
	}

	// Check for .lock suffix (reserved for committed drafts)
	if (name.endsWith(".lock")) {
		return {
			valid: false,
			error: "Name cannot end with .lock (reserved for committed drafts).",
		};
	}

	// Check for invalid characters
	if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
		return {
			valid: false,
			error:
				"Name must start with letter, contain only letters, numbers, hyphens, underscores.",
		};
	}

	return { valid: true };
}

export function registerDraftCommand(program: Command): void {
	program
		.command("draft <name>")
		.alias("create")
		.description("Create unnumbered draft folder in specs/")
		.option("--cwd <path>", "Working directory", process.cwd())
		.action((name: string, options: { cwd: string }) => {
			const cwd = options.cwd;
			const specsDir = join(cwd, "specs");
			const draftDir = join(specsDir, name);

			// Validate name
			const validation = validateName(name);
			if (!validation.valid) {
				console.error(`Error: ${validation.error}`);
				process.exit(1);
			}

			// Check if already exists
			if (existsSync(draftDir)) {
				console.error(`Error: Draft '${name}' already exists at ${draftDir}`);
				process.exit(1);
			}

			// Ensure specs/ exists
			if (!existsSync(specsDir)) {
				mkdirSync(specsDir, { recursive: true });
			}

			// Create draft directory
			mkdirSync(draftDir);

			// Create scope.md from template
			const scopeContent = SCOPE_TEMPLATE.replace(/\{\{NAME\}\}/g, name);
			writeFileSync(join(draftDir, "scope.md"), scopeContent);

			console.log(`Created draft: specs/${name}/`);
			console.log(`  scope.md (template)`);
			console.log(
				`\nNext: Edit scope.md, then 'ahoy number ${name}' when ready.`,
			);
		});
}
