/**
 * Initiative management commands
 *
 * ADR-0005: plans/{initiative}/ structure
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../state/config.js";
import { logEvent } from "../state/events.js";
import {
	getWorkingInitiative,
	setWorkingInitiative,
} from "../state/initiative.js";

/**
 * Generate STATUS.md template for new initiative
 */
function generateStatusTemplate(name: string): string {
	return `# Status: ${name}

## Active Work

<!-- SYNCED: tiller roadmap sync -->
| Phase | Plan | State | Intent |
|-------|------|-------|--------|
<!-- END SYNCED -->

## Progress

<!-- SYNCED: tiller roadmap sync -->
| Phase | Plans | Complete | Status |
|-------|-------|----------|--------|
<!-- END SYNCED -->
`;
}

/**
 * List existing initiatives
 */
export function listInitiatives(): string[] {
	const config = loadConfig();
	const plansDir = config.paths.plans;

	if (!existsSync(plansDir)) {
		return [];
	}

	return readdirSync(plansDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
}

export function registerInitiativeCommands(program: Command): void {
	const initiative = program
		.command("initiative")
		.description("Manage initiatives (multi-project support per ADR-0005)");

	// tiller initiative list
	initiative
		.command("list")
		.description("List all initiatives")
		.option("--json", "Output as JSON")
		.action((options: { json?: boolean }) => {
			const initiatives = listInitiatives();

			if (options.json) {
				console.log(JSON.stringify({ initiatives }, null, 2));
				return;
			}

			if (initiatives.length === 0) {
				console.log("No initiatives found in plans/");
				console.log("\nCreate one with: tiller initiative create <name>");
				return;
			}

			console.log("Initiatives:");
			for (const name of initiatives) {
				console.log(`  ${name}/`);
			}
		});

	// tiller initiative create <name>
	initiative
		.command("create <name>")
		.description("Create new initiative folder structure")
		.option("--description <text>", "Initiative description")
		.option("--dry-run", "Show what would be created without writing")
		.option("--json", "Output as JSON")
		.action(
			(
				name: string,
				options: {
					description?: string;
					dryRun?: boolean;
					json?: boolean;
				},
			) => {
				const config = loadConfig();
				const plansDir = config.paths.plans;
				const initiativeDir = join(plansDir, name);
				const statusPath = join(initiativeDir, "STATUS.md");

				// Check if already exists
				if (existsSync(initiativeDir)) {
					if (options.json) {
						console.log(
							JSON.stringify(
								{ error: "Initiative already exists", path: initiativeDir },
								null,
								2,
							),
						);
						process.exit(1);
					}
					console.error(`Error: Initiative '${name}' already exists at ${initiativeDir}`);
					process.exit(1);
				}

				const result = {
					action: "create",
					initiative: name,
					paths: {
						directory: initiativeDir,
						status: statusPath,
					},
				};

				// --dry-run or --json with --dry-run
				if (options.dryRun) {
					if (options.json) {
						console.log(JSON.stringify({ dryRun: true, ...result }, null, 2));
					} else {
						console.log("\n## Initiative Creation Plan\n");
						console.log("Will create:");
						console.log(`  Directory: ${initiativeDir}/`);
						console.log(`  File: ${statusPath}`);
						console.log("\n--dry-run: No changes made");
					}
					return;
				}

				// Execute: Create directory and STATUS.md
				mkdirSync(initiativeDir, { recursive: true });
				writeFileSync(statusPath, generateStatusTemplate(name));

				// Log event
				logEvent({
					event: "initiative_create",
					initiative: name,
					description: options.description ?? null,
				});

				// Output result
				if (options.json) {
					console.log(JSON.stringify({ ...result, success: true }, null, 2));
					return;
				}

				console.log(`✓ Created initiative '${name}'`);
				console.log(`  Directory: ${initiativeDir}/`);
				console.log(`  Status: ${statusPath}`);
				console.log("\nNext steps:");
				console.log(`  1. Create first phase: tiller phase insert 00 'Phase name' --initiative ${name}`);
				console.log(`  2. Or create plan directly: tiller plan create 'Objective' --initiative ${name} --phase 01`);
			},
		);

	// tiller initiative show <name>
	initiative
		.command("show <name>")
		.description("Show initiative details")
		.option("--json", "Output as JSON")
		.action((name: string, options: { json?: boolean }) => {
			const config = loadConfig();
			const initiativeDir = join(config.paths.plans, name);

			if (!existsSync(initiativeDir)) {
				if (options.json) {
					console.log(
						JSON.stringify({ error: "Initiative not found", name }, null, 2),
					);
					process.exit(1);
				}
				console.error(`Error: Initiative '${name}' not found`);
				process.exit(1);
			}

			// Count phases
			const phases = readdirSync(initiativeDir, { withFileTypes: true })
				.filter((d) => d.isDirectory() && /^\d+/.test(d.name))
				.map((d) => d.name);

			const result = {
				name,
				path: initiativeDir,
				phases: phases.length,
				phaseList: phases,
			};

			if (options.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			console.log(`Initiative: ${name}`);
			console.log(`Path: ${initiativeDir}/`);
			console.log(`Phases: ${phases.length}`);
			if (phases.length > 0) {
				console.log("\nPhase directories:");
				for (const phase of phases) {
					console.log(`  ${phase}/`);
				}
			}
		});

	// tiller initiative working (shows working initiative)
	// Alias: tiller initiative current (deprecated)
	const workingAction = (options: { json?: boolean }) => {
		const working = getWorkingInitiative();
		const config = loadConfig();
		const defaultInit = config.paths.default_initiative;

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						working: working,
						default: defaultInit,
						source: working === defaultInit ? "config" : "state",
					},
					null,
					2,
				),
			);
			return;
		}

		if (!working) {
			console.log("No working initiative set");
			console.log("\nSet one with: tiller initiative use <name>");
			return;
		}

		const source = working === defaultInit ? "(from config)" : "(from state)";
		console.log(`Working initiative: ${working} ${source}`);
		console.log(`Config default: ${defaultInit || "(not set)"}`);
	};

	initiative
		.command("working")
		.description("Show working initiative")
		.option("--json", "Output as JSON")
		.action(workingAction);

	// Deprecated alias
	initiative
		.command("current")
		.description("Show working initiative (deprecated: use 'working')")
		.option("--json", "Output as JSON")
		.action(workingAction);

	// tiller initiative use <name>
	initiative
		.command("use <name>")
		.description("Set current initiative (session state)")
		.option("--json", "Output as JSON")
		.action((name: string, options: { json?: boolean }) => {
			const config = loadConfig();
			const initiativeDir = join(config.paths.plans, name);

			// Validate initiative exists
			if (!existsSync(initiativeDir)) {
				if (options.json) {
					console.log(
						JSON.stringify({ error: "Initiative not found", name }, null, 2),
					);
					process.exit(1);
				}
				console.error(`Error: Initiative '${name}' not found`);
				console.error(`Available: ${listInitiatives().join(", ") || "(none)"}`);
				process.exit(1);
			}

			setWorkingInitiative(name);

			logEvent({
				event: "initiative_use",
				initiative: name,
			});

			if (options.json) {
				console.log(JSON.stringify({ current: name, success: true }, null, 2));
				return;
			}

			console.log(`✓ Now using initiative: ${name}`);
			console.log(`  Commands will default to plans/${name}/`);
		});

	// tiller initiative clear
	initiative
		.command("clear")
		.description("Clear current initiative (fall back to config default)")
		.option("--json", "Output as JSON")
		.action((options: { json?: boolean }) => {
			const previous = getWorkingInitiative();

			setWorkingInitiative(null);

			const newCurrent = getWorkingInitiative(); // Will be config default

			if (options.json) {
				console.log(
					JSON.stringify(
						{
							previous,
							current: newCurrent,
							source: "config",
						},
						null,
						2,
					),
				);
				return;
			}

			console.log(`✓ Cleared current initiative`);
			if (newCurrent) {
				console.log(`  Falling back to config default: ${newCurrent}`);
			} else {
				console.log(`  No config default set`);
			}
		});
}
