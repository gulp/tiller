/**
 * Prime commands - session priming and phase planning context
 *
 * Two prime commands:
 * - `ahoy prime` - Top-level session primer (like tiller prime)
 * - `ahoy phase prime` - Phase-specific TOON context
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { gatherPlanningContext } from "../context/gatherer.js";
import { serializeContext } from "../context/serializer.js";

// Paths
const SPECS_DIR = join(process.cwd(), "specs");
const PLANS_DIR = join(process.cwd(), "plans");
const AHOY_DIR = join(process.cwd(), ".ahoy");
const AHOY_PRIME_PATH = join(AHOY_DIR, "PRIME.md");

// Path to default prime template
const PRIME_TEMPLATE_PATH = join(
	import.meta.dirname,
	"../templates/PRIME_DEFAULT.md",
);

type DraftState = "drafting" | "numbered" | "locked";

interface Draft {
	name: string;
	state: DraftState;
	fileCount: number;
}

interface Initiative {
	name: string;
	phaseCount: number;
	planCount: number;
}

function classifyDraft(name: string): DraftState {
	if (name.endsWith(".lock")) return "locked";
	if (/^\d{4}-/.test(name)) return "numbered";
	return "drafting";
}

function scanDrafts(): Draft[] {
	if (!existsSync(SPECS_DIR)) return [];

	const entries = readdirSync(SPECS_DIR, { withFileTypes: true });
	const drafts: Draft[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const draftPath = join(SPECS_DIR, entry.name);
		const files = readdirSync(draftPath);
		drafts.push({
			name: entry.name,
			state: classifyDraft(entry.name),
			fileCount: files.length,
		});
	}

	return drafts;
}

function scanInitiatives(): Initiative[] {
	if (!existsSync(PLANS_DIR)) return [];

	const entries = readdirSync(PLANS_DIR, { withFileTypes: true });
	const initiatives: Initiative[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

		const initPath = join(PLANS_DIR, entry.name);
		try {
			const phases = readdirSync(initPath, { withFileTypes: true }).filter(
				(e) => e.isDirectory() && !e.name.startsWith("."),
			);

			let planCount = 0;
			for (const phase of phases) {
				const phasePath = join(initPath, phase.name);
				const files = readdirSync(phasePath);
				planCount += files.filter((f) => f.endsWith("-PLAN.md")).length;
			}

			initiatives.push({
				name: entry.name,
				phaseCount: phases.length,
				planCount,
			});
		} catch {
			// Skip on error
		}
	}

	return initiatives;
}

function getDefaultPrimeContent(): string {
	return readFileSync(PRIME_TEMPLATE_PATH, "utf-8");
}

/**
 * Register top-level prime command (session primer)
 */
export function registerTopLevelPrimeCommand(program: Command): void {
	program
		.command("prime")
		.description("Output workflow context (agent entry point)")
		.option("--json", "Output as JSON")
		.option("--export", "Output default content (ignores custom PRIME.md)")
		.option("--replace", "Replace mode: custom PRIME.md fully replaces default")
		.action((options: { json?: boolean; export?: boolean; replace?: boolean }) => {
			// --export: dump default content
			if (options.export) {
				console.log(getDefaultPrimeContent());
				return;
			}

			// Check for specs/ or plans/ - skip if neither exists
			const hasSpecs = existsSync(SPECS_DIR);
			const hasPlans = existsSync(PLANS_DIR);

			if (!hasSpecs && !hasPlans) {
				// Not an ahoy project, exit silently (for hooks)
				return;
			}

			const drafts = scanDrafts();
			const initiatives = scanInitiatives();

			if (options.json) {
				const byState = {
					drafting: drafts.filter((d) => d.state === "drafting"),
					numbered: drafts.filter((d) => d.state === "numbered"),
					locked: drafts.filter((d) => d.state === "locked"),
				};

				console.log(
					JSON.stringify(
						{
							drafts: byState,
							initiatives,
						},
						null,
						2,
					),
				);
				return;
			}

			// Output workflow context
			const hasCustomPrime = existsSync(AHOY_PRIME_PATH);

			if (hasCustomPrime) {
				console.log(readFileSync(AHOY_PRIME_PATH, "utf-8"));
				if (!options.replace) {
					console.log("\n---\n");
					console.log(getDefaultPrimeContent());
				}
			} else {
				console.log(getDefaultPrimeContent());
			}

			// Dynamic status
			console.log("\n## Current Status");

			// Drafts
			if (drafts.length > 0) {
				const byState = {
					drafting: drafts.filter((d) => d.state === "drafting"),
					numbered: drafts.filter((d) => d.state === "numbered"),
					locked: drafts.filter((d) => d.state === "locked"),
				};

				if (byState.drafting.length > 0) {
					console.log(`\nDrafts (${byState.drafting.length}):`);
					for (const d of byState.drafting.slice(0, 5)) {
						console.log(`  ${d.name}/ (${d.fileCount} files)`);
					}
					if (byState.drafting.length > 5) {
						console.log(`  ... and ${byState.drafting.length - 5} more`);
					}
				}

				if (byState.numbered.length > 0) {
					console.log(`\nProposals (${byState.numbered.length}):`);
					for (const d of byState.numbered.slice(0, 5)) {
						console.log(`  ${d.name}/ (${d.fileCount} files)`);
					}
					if (byState.numbered.length > 5) {
						console.log(`  ... and ${byState.numbered.length - 5} more`);
					}
				}

				if (byState.locked.length > 0) {
					console.log(`\nCommitted (${byState.locked.length}):`);
					for (const d of byState.locked.slice(0, 5)) {
						console.log(`  ${d.name}/ (${d.fileCount} files)`);
					}
					if (byState.locked.length > 5) {
						console.log(`  ... and ${byState.locked.length - 5} more`);
					}
				}
			}

			// Initiatives
			if (initiatives.length > 0) {
				console.log(`\nInitiatives (${initiatives.length}):`);
				for (const init of initiatives.slice(0, 5)) {
					console.log(
						`  ${init.name}/ (${init.phaseCount} phases, ${init.planCount} plans)`,
					);
				}
				if (initiatives.length > 5) {
					console.log(`  ... and ${initiatives.length - 5} more`);
				}
			}

			// Next action hints
			console.log(`\n${"─".repeat(50)}`);
			const hints: string[] = [];
			const byState = {
				drafting: drafts.filter((d) => d.state === "drafting"),
				numbered: drafts.filter((d) => d.state === "numbered"),
			};
			if (byState.drafting.length > 0) {
				hints.push(`ahoy number <draft>`);
			}
			if (byState.numbered.length > 0) {
				hints.push(`ahoy lock <draft>`);
			}
			if (hints.length > 0) {
				console.log(`Next: ${hints.join(" | ")}`);
			} else if (drafts.length === 0) {
				console.log("Next: ahoy draft <name> to create a spec");
			} else {
				console.log("Next: All drafts locked");
			}
		});
}

export function registerPrimeCommand(phaseCmd: Command): void {
	phaseCmd
		.command("prime <initiative> <phase>")
		.description("Output TOON-serialized planning context for a phase")
		.option("--json", "Output as JSON instead of TOON")
		.option(
			"--prompt <task>",
			"Wrap output in agent-ready format with task instruction",
		)
		.option("--stats", "Show token savings statistics")
		.action(
			async (
				initiative: string,
				phaseNum: string,
				options: { json?: boolean; prompt?: string; stats?: boolean },
			) => {
				try {
					// Validate mutually exclusive options
					if (options.json && options.prompt) {
						console.error("Error: --json and --prompt are mutually exclusive");
						process.exit(1);
					}

					const ctx = await gatherPlanningContext(
						initiative,
						parseInt(phaseNum, 10),
					);

					if (options.json) {
						console.log(JSON.stringify(ctx, null, 2));
					} else {
						const toon = serializeContext(ctx);

						if (options.prompt) {
							// Output in TOON sandwich format
							console.log(
								"Data is in TOON format (2-space indent, arrays show length and fields).",
							);
							console.log("");
							console.log("```toon");
							console.log(toon);
							console.log("```");
							console.log("");
							console.log(options.prompt);
						} else {
							console.log(toon);
						}

						if (options.stats) {
							const jsonSize = JSON.stringify(ctx).length;
							const toonSize = toon.length;
							const savings = (
								((jsonSize - toonSize) / jsonSize) *
								100
							).toFixed(1);
							console.error(`\n--- Stats ---`);
							console.error(`JSON: ${jsonSize} chars`);
							console.error(`TOON: ${toonSize} chars`);
							console.error(`Savings: ${savings}%`);
						}
					}
				} catch (error) {
					console.error(
						`Error: ${error instanceof Error ? error.message : String(error)}`,
					);
					process.exit(1);
				}
			},
		);
}
