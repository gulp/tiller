/**
 * Status command - Show draft lifecycle state
 *
 * Per ADR-0005: Drafts have lifecycle:
 *   unnumbered → numbered → locked
 *
 * Output: TOON by default (agent-first), --pretty for humans
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { outputTOON } from "../../tiller/types/toon.js";

type DraftState = "drafting" | "numbered" | "locked";

interface FileInfo {
	name: string;
	size: number;
	completeness?: string; // e.g., "3/5" for scope/research
}

interface Draft {
	name: string;
	state: DraftState;
	path: string;
	fileCount: number;
	files: FileInfo[];
}

/**
 * Classify a draft folder by its lifecycle state
 */
function classifyDraft(name: string): DraftState {
	if (name.endsWith(".lock")) {
		return "locked";
	}
	if (/^\d{4}-/.test(name)) {
		return "numbered";
	}
	return "drafting";
}

/**
 * Get display name (strip .lock suffix for locked drafts)
 */
function getDisplayName(name: string): string {
	return name.replace(/\.lock$/, "");
}

// Section definitions for completeness checking
const SCOPE_SECTIONS = ["problem", "desired_state", "in_scope", "out_scope", "success_criteria"];
const RESEARCH_SECTIONS = ["topic", "findings", "prior_art", "recommendations", "open_questions"];

// Template placeholders to detect empty sections
const TEMPLATE_PLACEHOLDERS = new Set([
	"What problem does this solve?",
	"What does success look like?",
	"-",
	"- [ ]",
	"What aspect is being researched?",
	"Key discoveries and insights.",
	"Existing solutions, patterns, or prior work.",
	"What to do based on findings.",
	"What still needs investigation.",
]);

/**
 * Check section completeness for a file
 * Filled = has content AND not a placeholder
 */
function checkCompleteness(content: string, sections: string[]): string {
	let filled = 0;
	for (const section of sections) {
		const regex = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`, "i");
		const match = content.match(regex);
		if (match) {
			const inner = match[1].replace(/^## .+\n+/m, "").trim();
			if (inner && !TEMPLATE_PLACEHOLDERS.has(inner)) {
				filled++;
			}
		}
	}
	return `${filled}/${sections.length}`;
}

/**
 * Scan specs/ for drafts and classify by lifecycle
 */
function scanDrafts(cwd: string = process.cwd()): Draft[] {
	const specsDir = join(cwd, "specs");
	if (!existsSync(specsDir)) {
		return [];
	}

	const entries = readdirSync(specsDir, { withFileTypes: true });
	const drafts: Draft[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const draftPath = join(specsDir, entry.name);
		const fileNames = readdirSync(draftPath);

		const files: FileInfo[] = fileNames.map((f) => {
			const filePath = join(draftPath, f);
			const stat = statSync(filePath);
			const info: FileInfo = { name: f, size: stat.size };

			// Add completeness for scope.md and research.md
			if (f === "scope.md" || f === "research.md") {
				try {
					const content = readFileSync(filePath, "utf-8");
					const sections = f === "scope.md" ? SCOPE_SECTIONS : RESEARCH_SECTIONS;
					info.completeness = checkCompleteness(content, sections);
				} catch {
					// Ignore read errors
				}
			}
			return info;
		});

		drafts.push({
			name: entry.name,
			state: classifyDraft(entry.name),
			path: draftPath,
			fileCount: files.length,
			files,
		});
	}

	return drafts;
}

/**
 * Format state for display
 */
function formatState(state: DraftState): string {
	switch (state) {
		case "drafting":
			return "drafting";
		case "numbered":
			return "numbered";
		case "locked":
			return "locked";
	}
}

export function registerStatusCommand(program: Command): void {
	program
		.command("status [draft]")
		.description("Show draft lifecycle state")
		.option("--json", "Output as JSON")
		.option("--pretty", "Human-readable output")
		.action(
			(
				draft: string | undefined,
				options: { json?: boolean; pretty?: boolean },
			) => {
				const cwd = process.cwd();
				const drafts = scanDrafts(cwd);

				// Fuzzy find: match "foo" to "0002-foo" or "0002-foo.lock"
				const fuzzyFind = (name: string) =>
					drafts.find(
						(d) =>
							d.name === name ||
							getDisplayName(d.name) === name ||
							d.name.endsWith(`-${name}`) ||
							d.name.endsWith(`-${name}.lock`),
					);

				if (options.json) {
					if (draft) {
						const found = fuzzyFind(draft);
						console.log(
							JSON.stringify(found ?? { error: "Not found" }, null, 2),
						);
						return;
					}
					// Fall through to use byState grouping below
				}

				if (draft) {
					// Show specific draft
					const found = fuzzyFind(draft);
					if (!found) {
						console.error(`Draft not found: ${draft}`);
						process.exit(1);
					}
					console.log(`Draft: ${found.name}`);
					console.log(`  State: ${formatState(found.state)}`);
					console.log(`  Files: ${found.fileCount}`);
					console.log(`  Path: ${found.path}`);
					return;
				}

				// Show all drafts grouped by state
				if (drafts.length === 0) {
					console.log("No drafts in specs/");
					console.log("\nCreate one with: ahoy draft <name>");
					return;
				}

				const byState = {
					drafts: drafts.filter((d) => d.state === "drafting"),
					proposals: drafts.filter((d) => d.state === "numbered"),
					committed: drafts.filter((d) => d.state === "locked"),
				};

				// Build next actions
				const nextActions: string[] = [];
				if (byState.drafts.length > 0) {
					nextActions.push("ahoy number <draft>");
				}
				if (byState.proposals.length > 0) {
					nextActions.push("ahoy lock <draft>");
				}

				// Build status data with file details
				const mapDraft = (d: Draft) => ({
					name: d.name,
					files: d.files.map((f) => ({
						name: f.name,
						size: f.size,
						...(f.completeness && { completeness: f.completeness }),
					})),
				});

				const statusData = {
					drafts: byState.drafts.map(mapDraft),
					proposals: byState.proposals.map(mapDraft),
					committed: byState.committed.map(mapDraft),
					next: nextActions,
				};

				// JSON output (after byState grouping)
				if (options.json) {
					console.log(JSON.stringify(statusData, null, 2));
					return;
				}

				// Pretty output function
				const printPretty = () => {
					if (byState.drafts.length > 0) {
						console.log("Drafts (work in progress):");
						for (const d of byState.drafts) {
							console.log(`  ${d.name}/ (${d.fileCount} files)`);
						}
						console.log();
					}

					if (byState.proposals.length > 0) {
						console.log("Proposals (ready for review):");
						for (const d of byState.proposals) {
							console.log(`  ${d.name}/ (${d.fileCount} files)`);
						}
						console.log();
					}

					if (byState.committed.length > 0) {
						console.log("Committed (immutable):");
						for (const d of byState.committed) {
							console.log(`  ${d.name}/ (${d.fileCount} files)`);
						}
						console.log();
					}

					if (nextActions.length > 0) {
						console.log(`Next: ${nextActions.join(" | ")}`);
					}
				};

				// --pretty flag
				if (options.pretty) {
					printPretty();
					return;
				}

				// Default: TOON output with agent_hint
				const counts = [];
				if (byState.drafts.length > 0)
					counts.push(`${byState.drafts.length} drafts`);
				if (byState.proposals.length > 0)
					counts.push(`${byState.proposals.length} proposals`);
				if (byState.committed.length > 0)
					counts.push(`${byState.committed.length} committed`);
				const summary = counts.join(", ") || "none";

				outputTOON(
					{ status: statusData },
					{
						agent_hint: `Present spec status. Summary: "${summary}". Show as grouped list: Drafts | Proposals | Committed with file counts.`,
						prettyFn: printPretty,
					},
				);
			},
		);
}
