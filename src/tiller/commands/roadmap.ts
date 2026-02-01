/**
 * Roadmap and phase commands
 *
 * - tiller roadmap create: Create new ROADMAP.md from template
 * - tiller roadmap sync: Hydrate ROADMAP.md SYNCED sections from run states
 * - tiller roadmap import: Import manual [x] completions as retroactive runs
 * - tiller phase status: Show derived phase state from runs
 * - tiller phase insert: Insert new phase (default: root with renumbering, --decimal for subphase)
 * - tiller phase remove: Remove phase and renumber subsequent phases
 * - tiller phase show: Show detailed phase information
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { extractCheckboxItems } from "../markdown/parser.js";
import { loadConfig } from "../state/config.js";
import { logEvent } from "../state/events.js";
import { resolveInitiative } from "../state/initiative.js";
import {
	findNextDecimal,
	generateSlug,
	comparePhaseIds,
	getAllPhases,
	getPhaseDir,
	getPhaseInfo,
	getPhaseStateSymbol,
	getPhasesToRenumber,
	type PhaseInfo,
	parsePhaseId,
	phaseExists,
	phaseHasActiveWork,
	phaseHasCompletedWork,
	renamePhaseDir,
	updatePlanFrontmatter,
} from "../state/phase.js";
import {
	generatePhaseSection,
	insertPhaseSection,
	removePhaseSection,
	renumberRoadmapReferences,
	updatePhaseChecklist,
} from "../state/roadmap-file.js";
import { createRun, getRunPlanRef, listRuns, saveRun } from "../state/run.js";

const ROADMAP_PATH = ".planning/ROADMAP.md";
const PLANNING_DIR = ".planning";
const PHASES_DIR = ".planning/phases";

// Sync fence markers
const SYNC_START = "<!-- SYNCED: tiller roadmap sync -->";
const SYNC_END = "<!-- END SYNCED -->";

interface SyncResult {
	phaseId: string;
	action: "updated" | "skipped" | "no-fence";
	reason?: string;
}

/**
 * Generate synced content for a phase
 */
function generateSyncedContent(phase: PhaseInfo): string {
	const lines: string[] = [];

	// Plan count
	lines.push(`**Plans**: ${phase.progress.total} plans`);
	lines.push("");
	lines.push("Plans:");

	// Plan checkboxes from tracks
	for (const track of phase.tracks) {
		// Extract plan number from plan_path (e.g., "03.5-01-PLAN.md" -> "01")
		const planMatch = track.plan_path.match(/(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/);
		if (planMatch) {
			const planNum = planMatch[2];
			const checkbox = track.state === "complete" ? "[x]" : "[ ]";
			// Truncate intent if too long
			const intent =
				track.intent.length > 60
					? `${track.intent.slice(0, 57)}...`
					: track.intent;
			lines.push(`- ${checkbox} ${phase.id}-${planNum}: ${intent}`);
		}
	}

	return lines.join("\n");
}

/**
 * Sync a single phase section in ROADMAP.md
 * Returns the modified content and sync result
 */
function syncPhaseSection(
	content: string,
	phaseId: string,
	phase: PhaseInfo | null,
): { content: string; result: SyncResult } {
	// Find the phase section header
	const sectionRegex = new RegExp(
		`### Phase ${phaseId.replace(".", "\\.")}:.*?\n`,
		"g",
	);
	const sectionMatch = sectionRegex.exec(content);

	if (!sectionMatch) {
		return {
			content,
			result: { phaseId, action: "skipped", reason: "Phase section not found" },
		};
	}

	// Find SYNCED fence within this section
	const sectionStart = sectionMatch.index;
	const nextSectionMatch = content
		.slice(sectionStart + sectionMatch[0].length)
		.match(/\n### /);
	const sectionEnd = nextSectionMatch
		? sectionStart + sectionMatch[0].length + nextSectionMatch.index!
		: content.length;

	const section = content.slice(sectionStart, sectionEnd);
	const fenceStart = section.indexOf(SYNC_START);

	if (fenceStart === -1) {
		return {
			content,
			result: { phaseId, action: "no-fence", reason: "No SYNCED fence found" },
		};
	}

	const fenceEnd = section.indexOf(SYNC_END);
	if (fenceEnd === -1) {
		return {
			content,
			result: {
				phaseId,
				action: "skipped",
				reason: "Malformed fence (no END)",
			},
		};
	}

	if (!phase) {
		return {
			content,
			result: { phaseId, action: "skipped", reason: "No phase info available" },
		};
	}

	// Generate new synced content
	const newSyncedContent = generateSyncedContent(phase);
	const newSection =
		section.slice(0, fenceStart + SYNC_START.length) +
		"\n" +
		newSyncedContent +
		"\n" +
		section.slice(fenceEnd);

	const newContent =
		content.slice(0, sectionStart) + newSection + content.slice(sectionEnd);

	return {
		content: newContent,
		result: { phaseId, action: "updated" },
	};
}

/**
 * Generate initial ROADMAP.md content
 */
function generateRoadmapTemplate(
	title: string,
	options: {
		initPhase?: string;
		overview?: string;
	} = {},
): string {
	const overview =
		options.overview || `[Describe the goals and architecture of ${title}]`;

	let content = `# Roadmap: ${title}

## Overview

${overview}

## Domain Expertise

None

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

### ${title} Milestone (Current)

`;

	if (options.initPhase) {
		content += `- [ ] **Phase 1: ${options.initPhase}** - ${options.initPhase}

## Phase Details

### Phase 1: ${options.initPhase}
**Goal**: [Goal for ${options.initPhase}]
**Depends on**: Nothing (first phase)
**Research**: Likely
**Plans**: TBD

Plans:
- [ ] 01-01: [First plan]

`;
	} else {
		content += `[Add phases here]

## Phase Details

[Add phase details here]

`;
	}

	content += `## Progress
<!-- Writer: tiller -->

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
`;

	if (options.initPhase) {
		content += `| 01 | 0/1 | Planning | - |
`;
	}

	return content;
}

/**
 * Register roadmap and phase commands
 */
export function registerRoadmapCommands(program: Command): void {
	// tiller roadmap group
	const roadmap = program
		.command("roadmap")
		.description("Roadmap management commands");

	// tiller roadmap sync
	roadmap
		.command("sync")
		.description("Sync ROADMAP.md SYNCED sections from run states")
		.option("--dry-run", "Show what would change without writing")
		.option("--json", "Output results as JSON")
		.action((options) => {
			if (!existsSync(ROADMAP_PATH)) {
				console.error(`Error: ${ROADMAP_PATH} not found`);
				process.exit(1);
			}

			let content = readFileSync(ROADMAP_PATH, "utf-8");
			const phases = getAllPhases();
			const results: SyncResult[] = [];

			// Find all phase sections with SYNCED fences
			const phaseSectionRegex = /### Phase (\d+(?:\.\d+)?):/g;
			let match;
			const phaseIds: string[] = [];

			while ((match = phaseSectionRegex.exec(content)) !== null) {
				phaseIds.push(match[1]);
			}

			// Sync each phase
			for (const phaseId of phaseIds) {
				const phase = phases.find((p) => p.id === phaseId) ?? null;
				const { content: newContent, result } = syncPhaseSection(
					content,
					phaseId,
					phase,
				);
				content = newContent;
				results.push(result);
			}

			// Output results
			if (options.json) {
				console.log(JSON.stringify({ results }, null, 2));
				return;
			}

			// Summary
			const updated = results.filter((r) => r.action === "updated");
			const noFence = results.filter((r) => r.action === "no-fence");
			const skipped = results.filter((r) => r.action === "skipped");

			if (updated.length > 0) {
				console.log(`\nUpdated (${updated.length}):`);
				for (const r of updated) {
					console.log(`  ✓ Phase ${r.phaseId}`);
				}
			}

			if (noFence.length > 0) {
				console.log(`\nNo fence (${noFence.length}):`);
				for (const r of noFence) {
					console.log(
						`  ○ Phase ${r.phaseId} - Add SYNCED fence to enable sync`,
					);
				}
			}

			if (skipped.length > 0) {
				console.log(`\nSkipped (${skipped.length}):`);
				for (const r of skipped) {
					console.log(`  - Phase ${r.phaseId}: ${r.reason}`);
				}
			}

			if (options.dryRun) {
				console.log("\n--dry-run: No changes written");
				return;
			}

			// Write if any updates
			if (updated.length > 0) {
				writeFileSync(ROADMAP_PATH, content);
				console.log(`\nWrote ${ROADMAP_PATH}`);
			} else {
				console.log("\nNo changes to write");
			}
		});

	// tiller roadmap import
	roadmap
		.command("import")
		.description(
			"Import manual [x] completions from ROADMAP.md as retroactive tracks",
		)
		.option("--dry-run", "Show what would be imported without making changes")
		.option("--json", "Output as JSON")
		.action((options: { dryRun?: boolean; json?: boolean }) => {
			if (!existsSync(ROADMAP_PATH)) {
				console.error(`Error: ${ROADMAP_PATH} not found`);
				process.exit(1);
			}

			const content = readFileSync(ROADMAP_PATH, "utf-8");
			const checkboxes = extractCheckboxItems(content);

			// Filter to checked items that look like plan refs (XX-YY: description)
			const planRefPattern = /^(\d+(?:\.\d+)?-\d+):\s*(.+)$/;
			const completedPlans = checkboxes
				.filter((item) => item.checked)
				.map((item) => {
					const match = item.text.match(planRefPattern);
					if (match) {
						return { ref: match[1], description: match[2] };
					}
					return null;
				})
				.filter((p): p is { ref: string; description: string } => p !== null);

			// Find which don't have tracks
			const existingTracks = listRuns();
			const trackedRefs = new Set(existingTracks.map((t) => getRunPlanRef(t)));
			const untracked = completedPlans.filter((p) => !trackedRefs.has(p.ref));

			if (options.json) {
				console.log(
					JSON.stringify(
						{
							total_completed: completedPlans.length,
							already_tracked: completedPlans.length - untracked.length,
							untracked: untracked,
						},
						null,
						2,
					),
				);
				return;
			}

			if (untracked.length === 0) {
				console.log("✓ All ROADMAP [x] completions have runs");
				return;
			}

			console.log(
				`Found ${untracked.length} plan(s) marked [x] without runs:\n`,
			);
			for (const p of untracked) {
				console.log(`  ${p.ref}: ${p.description}`);
			}

			if (options.dryRun) {
				console.log("\n--dry-run: No changes made");
				return;
			}

			// Create retroactive runs
			console.log("\nCreating retroactive runs...");
			const config = loadConfig();

			for (const p of untracked) {
				// Derive plan path from ref
				const phaseId = p.ref.split("-")[0];
				const phaseDir = getPhaseDir(phaseId);
				if (!phaseDir) {
					console.log(`  ✗ ${p.ref}: Phase ${phaseId} not found`);
					continue;
				}

				const planPath = join(config.paths.plans, phaseDir, `${p.ref}-PLAN.md`);
				if (!existsSync(planPath)) {
					console.log(`  ✗ ${p.ref}: PLAN.md not found at ${planPath}`);
					continue;
				}

				// Create track and fast-forward to complete
				const track = createRun(planPath, p.description);
				const now = new Date().toISOString();
				track.state = "complete";
				track.updated = now;
				track.transitions = [
					{
						from: "proposed",
						to: "complete",
						at: now,
						by: "agent",
						reason: "roadmap-import",
					},
				];
				saveRun(track);
				logEvent({ event: "roadmap_import", track: track.id, plan: p.ref });

				console.log(`  ✓ ${p.ref} → complete (retroactive)`);
			}

			console.log(
				"\nDone. Run `tiller roadmap sync` to update ROADMAP.md SYNCED sections.",
			);
		});

	// tiller roadmap create <title>
	roadmap
		.command("create <title>")
		.description("Create new ROADMAP.md from template")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--init-phase <name>", "Create initial phase 01 with given name")
		.option("--overview <text>", "Project overview text")
		.option("--dry-run", "Show what would be created without writing")
		.option("--json", "Output as JSON")
		.option(
			"--confirm",
			"Return TOON for human confirmation instead of executing",
		)
		.action(
			(
				title: string,
				options: {
					initiative?: string;
					initPhase?: string;
					overview?: string;
					dryRun?: boolean;
					json?: boolean;
					confirm?: boolean;
				},
			) => {
				const config = loadConfig();
				const initiative = resolveInitiative(options.initiative);

				// Resolve roadmap path based on initiative
				let roadmapPath: string;
				let initiativeDir: string | null = null;
				let phasesBaseDir: string;

				if (initiative) {
					// Per-initiative roadmap: plans/{initiative}/ROADMAP.md
					initiativeDir = join(config.paths.plans, initiative);
					roadmapPath = join(initiativeDir, "ROADMAP.md");
					phasesBaseDir = initiativeDir;
				} else {
					// Global roadmap (legacy)
					roadmapPath = ROADMAP_PATH;
					phasesBaseDir = PHASES_DIR;
				}

				// Check if ROADMAP.md already exists
				if (existsSync(roadmapPath)) {
					if (options.json) {
						console.log(
							JSON.stringify(
								{
									error: "ROADMAP.md already exists",
									path: roadmapPath,
								},
								null,
								2,
							),
						);
						process.exit(1);
					}
					console.error(`Error: ${roadmapPath} already exists`);
					console.error("Use 'tiller roadmap sync' to update existing roadmap");
					process.exit(1);
				}

				// Generate template
				const content = generateRoadmapTemplate(title, {
					initPhase: options.initPhase,
					overview: options.overview,
				});

				// Build result summary
				const result = {
					action: "create",
					path: roadmapPath,
					title,
					initiative: initiative ?? null,
					initPhase: options.initPhase ?? null,
					directories: [] as string[],
				};

				// Add initiative directory if needed
				if (initiativeDir && !existsSync(initiativeDir)) {
					result.directories.push(initiativeDir);
				}

				// Add phase directory if creating initial phase
				if (options.initPhase) {
					const slug = generateSlug(options.initPhase.split(/\s+/));
					const phaseDirPath = join(phasesBaseDir, `01-${slug}`);
					result.directories.push(phaseDirPath);
				}

				// Add .planning directory (legacy case)
				if (!initiative && !existsSync(PLANNING_DIR)) {
					result.directories.unshift(PLANNING_DIR);
				}

				// --json with --dry-run
				if (options.json && options.dryRun) {
					console.log(JSON.stringify({ dryRun: true, ...result }, null, 2));
					return;
				}

				// --confirm or --dry-run: Show plan
				if (options.confirm || options.dryRun) {
					console.log("\n## Roadmap Creation Plan\n");
					console.log("Will create:");
					console.log(`  File: ${roadmapPath}`);
					console.log(`  Title: ${title}`);
					if (initiative) {
						console.log(`  Initiative: ${initiative}`);
					}

					if (result.directories.length > 0) {
						console.log("\nDirectories:");
						for (const dir of result.directories) {
							console.log(`  ${dir}/`);
						}
					}

					if (options.initPhase) {
						console.log(`\nInitial phase: Phase 1: ${options.initPhase}`);
					}

					if (options.dryRun) {
						console.log("\n--dry-run: No changes made");
					} else {
						const args = [`"${title}"`];
						if (options.initiative) {
							args.push(`--initiative "${options.initiative}"`);
						}
						if (options.initPhase) {
							args.push(`--init-phase "${options.initPhase}"`);
						}
						if (options.overview) {
							args.push(`--overview "${options.overview}"`);
						}
						console.log(
							`\nTo execute: \`tiller roadmap create ${args.join(" ")}\``,
						);
					}
					return;
				}

				// Execute: Create directories and files
				// 1. Create base directories as needed
				if (initiative) {
					// For initiative, create the initiative directory
					if (initiativeDir && !existsSync(initiativeDir)) {
						mkdirSync(initiativeDir, { recursive: true });
					}
				} else {
					// Legacy: create .planning directory
					if (!existsSync(PLANNING_DIR)) {
						mkdirSync(PLANNING_DIR, { recursive: true });
					}
				}

				// 2. Create phase directory if --init-phase
				if (options.initPhase) {
					const slug = generateSlug(options.initPhase.split(/\s+/));
					const phaseDirPath = join(phasesBaseDir, `01-${slug}`);
					mkdirSync(phaseDirPath, { recursive: true });
				}

				// 3. Write ROADMAP.md
				writeFileSync(roadmapPath, content);

				// Log event
				logEvent({
					event: "roadmap_create",
					title,
					initiative: initiative ?? null,
					initPhase: options.initPhase ?? null,
				});

				// Output result
				if (options.json) {
					console.log(JSON.stringify({ ...result, success: true }, null, 2));
					return;
				}

				console.log(`✓ Created ${roadmapPath}`);
				console.log(`  Title: ${title}`);
				if (initiative) {
					console.log(`  Initiative: ${initiative}`);
				}
				if (options.initPhase) {
					const slug = generateSlug(options.initPhase.split(/\s+/));
					console.log(`  Phase directory: ${phasesBaseDir}/01-${slug}/`);
				}
				console.log("\nNext steps:");
				console.log("  1. Edit ROADMAP.md to add overview and phases");
				if (!options.initPhase) {
					console.log(
						"  2. Add phase directories: tiller phase insert 00 'Phase name'",
					);
				}
				console.log("  3. Create plans in phase directories");
			},
		);

	// tiller phase group
	const phase = program.command("phase").description("Phase status commands");

	// tiller phase status [phase-id]
	phase
		.command("status [phase-id]")
		.description("Show derived phase state from runs")
		.option("--json", "Output as JSON")
		.action((phaseId?: string, options?: { json?: boolean }) => {
			if (phaseId) {
				// Show specific phase
				const info = getPhaseInfo(phaseId);
				if (!info) {
					console.error(`Phase ${phaseId} not found`);
					process.exit(1);
				}

				if (options?.json) {
					console.log(JSON.stringify(info, null, 2));
					return;
				}

				displayPhaseInfo(info);
			} else {
				// Show all phases
				const phases = getAllPhases();

				if (options?.json) {
					console.log(JSON.stringify(phases, null, 2));
					return;
				}

				if (phases.length === 0) {
					console.log("No phases found in .planning/phases/");
					return;
				}

				console.log("Phases:\n");
				for (const p of phases) {
					const symbol = getPhaseStateSymbol(p.state);
					const progress =
						p.progress.total > 0
							? ` (${p.progress.complete}/${p.progress.total} tracks complete)`
							: "";
					console.log(`  ${symbol} ${p.id}: ${p.name} - ${p.state}${progress}`);
				}
			}
		});

	// tiller phase list (alias for status without args)
	phase
		.command("list")
		.description("List all phases with their derived states")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--json", "Output as JSON")
		.action((options: { initiative?: string; json?: boolean }) => {
			const config = loadConfig();
			const initiative = resolveInitiative(options.initiative);

			// Resolve phases directory based on initiative
			let phasesDir: string;
			if (initiative) {
				phasesDir = join(config.paths.plans, initiative);
			} else {
				phasesDir = config.paths.plans;
			}

			// Scan phases in the resolved directory
			if (!existsSync(phasesDir)) {
				if (options.json) {
					console.log(JSON.stringify([], null, 2));
				} else {
					console.log(
						initiative ? `No phases found in ${initiative}` : "No phases found",
					);
				}
				return;
			}

			const dirs = readdirSync(phasesDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);

			// Build lightweight phase list from directory names
			interface PhaseListItem {
				id: string;
				name: string;
				planCount: number;
			}
			const phaseItems: PhaseListItem[] = [];
			for (const dir of dirs) {
				const match = dir.match(/^(\d+(?:\.\d+)?)-(.+)$/);
				if (!match) continue;
				const phaseId = match[1];
				const phaseName = match[2];
				// Count plan files in this phase
				const phaseFullPath = join(phasesDir, dir);
				const planFiles = readdirSync(phaseFullPath).filter((f) =>
					f.endsWith("-PLAN.md"),
				);
				phaseItems.push({
					id: phaseId,
					name: phaseName,
					planCount: planFiles.length,
				});
			}

			// Sort by phase ID
			phaseItems.sort((a, b) => {
				const parseId = (id: string) =>
					id.split(".").map((p) => parseInt(p, 10));
				const aparts = parseId(a.id);
				const bparts = parseId(b.id);
				for (let i = 0; i < Math.max(aparts.length, bparts.length); i++) {
					const av = aparts[i] ?? 0;
					const bv = bparts[i] ?? 0;
					if (av !== bv) return av - bv;
				}
				return 0;
			});

			if (options.json) {
				console.log(JSON.stringify(phaseItems, null, 2));
				return;
			}

			if (phaseItems.length === 0) {
				console.log(
					initiative ? `No phases found in ${initiative}` : "No phases found",
				);
				return;
			}

			console.log(initiative ? `\nPhases (${initiative}):\n` : "\nPhases:\n");
			for (const p of phaseItems) {
				console.log(`  ○ Phase ${p.id}: ${p.name} [${p.planCount} plans]`);
			}
			console.log("");
		});

	// tiller phase show <phase-number> (alias for status with single phase)
	phase
		.command("show <phaseNumber>")
		.description("Show detailed phase information")
		.option("--json", "Output as JSON")
		.action((phaseNumber: string, options: { json?: boolean }) => {
			const info = getPhaseInfo(phaseNumber);
			if (!info) {
				console.error(`Phase ${phaseNumber} not found`);
				process.exit(1);
			}

			if (options.json) {
				console.log(JSON.stringify(info, null, 2));
				return;
			}

			displayPhaseInfo(info);
		});

	// tiller phase create <phase-id> <name>
	// Creates a new phase directory (Stallman principle: create creates, insert inserts)
	phase
		.command("create <phaseId> <name>")
		.description(
			"Create new phase directory (use 'insert' to add between existing phases)",
		)
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--dry-run", "Show what would be created without writing")
		.action(
			(
				phaseId: string,
				name: string,
				options: { initiative?: string; dryRun?: boolean },
			) => {
				const config = loadConfig();
				const initiative = resolveInitiative(options.initiative);

				// Resolve plans directory based on initiative
				let phasesDir: string;
				if (initiative) {
					phasesDir = join(config.paths.plans, initiative);
				} else {
					phasesDir = config.paths.plans;
				}

				// Normalize phase ID
				const normalizedId = phaseId.padStart(2, "0");
				const slug = generateSlug(name.split(/\s+/));
				const phaseDirName = `${normalizedId}-${slug}`;
				const fullPath = join(phasesDir, phaseDirName);

				// Check if phase already exists
				if (existsSync(fullPath)) {
					console.error(`Phase already exists: ${fullPath}`);
					process.exit(1);
				}

				// Check if any phase with this ID exists
				const existingPhase = getPhaseDir(normalizedId);
				if (existingPhase) {
					console.error(
						`Phase ${normalizedId} already exists: ${existingPhase}`,
					);
					console.error(
						`Use 'tiller phase insert' to add between existing phases.`,
					);
					process.exit(1);
				}

				if (options.dryRun) {
					console.log("## Phase Creation\n");
					console.log("Will create:");
					console.log(`  Directory: ${fullPath}`);
					console.log(`  Phase ID: ${normalizedId}`);
					console.log(`  Name: ${name}`);
					if (initiative) {
						console.log(`  Initiative: ${initiative}`);
					}
					console.log("\n--dry-run: No changes made");
					return;
				}

				// Ensure parent directory exists
				if (!existsSync(phasesDir)) {
					mkdirSync(phasesDir, { recursive: true });
				}

				// Create phase directory
				mkdirSync(fullPath, { recursive: true });

				console.log(`✓ Created phase: ${phaseDirName}`);
				console.log(`  Path: ${fullPath}`);
				if (initiative) {
					console.log(`  Initiative: ${initiative}`);
				}
				console.log(
					`\nNext: tiller plan create "<objective>" --phase ${normalizedId}`,
				);
			},
		);

	// tiller phase insert <after-phase> <description>
	// Default: Insert root phase with renumbering (06 → creates 07, renumbers 07→08)
	// --decimal: Insert decimal subphase (06 → creates 06.1)
	phase
		.command("insert <afterPhase> <description>")
		.description(
			"Insert new phase after existing (default: root phase with renumbering, --decimal for subphase)",
		)
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--decimal", "Create decimal subphase (06.1) instead of root phase")
		.option(
			"--confirm",
			"Return TOON for human confirmation instead of executing",
		)
		.option("--dry-run", "Show what would change without modifying")
		.option("--json", "Output as JSON")
		.action(
			(
				afterPhase: string,
				description: string,
				options: {
					initiative?: string;
					decimal?: boolean;
					confirm?: boolean;
					dryRun?: boolean;
					json?: boolean;
				},
			) => {
				const config = loadConfig();
				const initiative = resolveInitiative(options.initiative);

				// Resolve plans directory based on initiative
				let phasesDir: string;
				if (initiative) {
					phasesDir = join(config.paths.plans, initiative);
				} else {
					phasesDir = config.paths.plans;
				}

				// Normalize phase ID (remove leading zeros for comparison)
				const normalizedAfter = parsePhaseId(afterPhase)[0]
					.toString()
					.padStart(2, "0");

				// Validate base phase exists within initiative
				const phaseExistsInInit = (id: string): boolean => {
					if (!existsSync(phasesDir)) return false;
					const dirs = readdirSync(phasesDir);
					return dirs.some((d) => d.startsWith(`${id}-`));
				};

				if (
					!phaseExistsInInit(normalizedAfter) &&
					!phaseExistsInInit(afterPhase)
				) {
					console.error(
						`Error: Phase ${afterPhase} does not exist in ${phasesDir}`,
					);
					console.error("Use 'tiller phase list' to see available phases");
					process.exit(1);
				}
				const slug = generateSlug(description.split(/\s+/));
				const phaseName = description;

				// --decimal: Create decimal subphase (original behavior)
				if (options.decimal) {
					const newPhaseId = findNextDecimal(afterPhase);
					const newDirName = `${newPhaseId}-${slug}`;
					const newDirPath = join(phasesDir, newDirName);

					if (existsSync(newDirPath)) {
						console.error(`Error: Directory ${newDirName} already exists`);
						process.exit(1);
					}

					// --confirm or --dry-run: Show plan
					if (options.confirm || options.dryRun) {
						console.log("\n## Phase Insert (Decimal Subphase)\n");
						console.log("Will create:");
						console.log(`- Directory: ${newDirPath}`);
						console.log(`- Phase ID: ${newPhaseId}`);
						console.log(`- Name: ${phaseName}`);
						console.log(`- Depends on: Phase ${afterPhase}`);
						if (options.dryRun) {
							console.log("\n--dry-run: No changes made");
						} else {
							console.log(
								`\nTo execute: \`tiller phase insert ${afterPhase} "${description}" --decimal\``,
							);
						}
						return;
					}

					// Execute: Create directory
					mkdirSync(newDirPath, { recursive: true });

					// Generate and insert ROADMAP.md section
					const section = generatePhaseSection(
						newPhaseId,
						phaseName,
						afterPhase,
						{
							inserted: true,
						},
					);

					try {
						insertPhaseSection(afterPhase, section);
					} catch (err) {
						console.error(`Warning: Could not update ROADMAP.md: ${err}`);
						console.error("You may need to add the phase section manually");
					}

					// Output result
					if (options.json) {
						console.log(
							JSON.stringify(
								{
									action: "created",
									type: "decimal",
									phaseId: newPhaseId,
									name: phaseName,
									directory: newDirPath,
									dependsOn: afterPhase,
								},
								null,
								2,
							),
						);
						return;
					}

					console.log(`✓ Created decimal subphase ${newPhaseId}: ${phaseName}`);
					console.log(`  Directory: ${newDirPath}`);
					console.log(`  Depends on: Phase ${afterPhase}`);
					return;
				}

				// Default: Create root phase with renumbering
				const afterInt = parsePhaseId(afterPhase)[0];
				const newPhaseInt = afterInt + 1;
				const newPhaseId = newPhaseInt.toString().padStart(2, "0");
				const newDirName = `${newPhaseId}-${slug}`;
				const newDirPath = join(phasesDir, newDirName);

				// Get phases that need renumbering (phases >= newPhaseInt)
				const allPhases = getAllPhases();
				const phasesToShift = allPhases
					.filter((p) => {
						const phaseNum = parsePhaseId(p.id);
						// Only integer phases (no decimal) that are >= new phase
						return phaseNum.length === 1 && phaseNum[0] >= newPhaseInt;
					})
					.sort((a, b) => parsePhaseId(b.id)[0] - parsePhaseId(a.id)[0]); // Descending for safe rename

				// Build renumber map (old -> new, incrementing by 1)
				const renumberMap = new Map<string, string>();
				for (const p of phasesToShift) {
					const oldInt = parsePhaseId(p.id)[0];
					const newInt = oldInt + 1;
					const newId = newInt.toString().padStart(2, "0");
					renumberMap.set(p.id, newId);
				}

				// Build changes summary
				const changes = {
					create: {
						phaseId: newPhaseId,
						name: phaseName,
						directory: newDirPath,
					},
					renumber: Array.from(renumberMap.entries())
						.sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
						.map(([old, newId]) => ({
							from: old,
							to: newId,
							name: phasesToShift.find((p) => p.id === old)?.name,
						})),
				};

				// --json with --dry-run
				if (options.json && options.dryRun) {
					console.log(JSON.stringify({ dryRun: true, ...changes }, null, 2));
					return;
				}

				// --confirm or --dry-run: Show plan
				if (options.confirm || options.dryRun) {
					console.log("\n## Phase Insert (Root Phase with Renumbering)\n");
					console.log("Will create:");
					console.log(`- Phase ID: ${newPhaseId}`);
					console.log(`- Name: ${phaseName}`);
					console.log(`- Directory: ${newDirPath}`);

					if (renumberMap.size > 0) {
						console.log("\nWill renumber:");
						for (const item of changes.renumber) {
							console.log(`  ${item.from} → ${item.to} (${item.name})`);
						}
					}

					if (options.dryRun) {
						console.log("\n--dry-run: No changes made");
					} else {
						console.log(
							`\nTo execute: \`tiller phase insert ${afterPhase} "${description}"\``,
						);
					}
					return;
				}

				// Execute: Renumber existing phases first (in descending order)
				for (const [oldId, newId] of renumberMap) {
					// Rename directory and files
					renamePhaseDir(oldId, newId);

					// Update frontmatter in plan files
					const newDir = getPhaseDir(newId);
					if (newDir) {
						updatePlanFrontmatter(newDir, oldId, newId);
					}
				}

				// Update ROADMAP.md references
				if (renumberMap.size > 0) {
					renumberRoadmapReferences(renumberMap);
					updatePhaseChecklist(renumberMap);
				}

				// Create new phase directory
				mkdirSync(newDirPath, { recursive: true });

				// Generate and insert ROADMAP.md section
				const section = generatePhaseSection(
					newPhaseId,
					phaseName,
					afterPhase,
					{
						inserted: true,
					},
				);

				try {
					insertPhaseSection(afterPhase, section);
				} catch (err) {
					console.error(`Warning: Could not update ROADMAP.md: ${err}`);
					console.error("You may need to add the phase section manually");
				}

				// Output result
				if (options.json) {
					console.log(
						JSON.stringify(
							{
								action: "created",
								type: "root",
								...changes,
							},
							null,
							2,
						),
					);
					return;
				}

				console.log(`✓ Created root phase ${newPhaseId}: ${phaseName}`);
				console.log(`  Directory: ${newDirPath}`);
				if (renumberMap.size > 0) {
					console.log(`  Renumbered ${renumberMap.size} phase(s)`);
				}
			},
		);

	// tiller phase rename <phase-number> <new-name>
	phase
		.command("rename <phaseNumber> <newName>")
		.description("Rename a phase directory (change the slug, keep the number)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--dry-run", "Show what would change without modifying")
		.option("--json", "Output as JSON")
		.action(
			(
				phaseNumber: string,
				newName: string,
				options: { initiative?: string; dryRun?: boolean; json?: boolean },
			) => {
				const config = loadConfig();
				const initiative = resolveInitiative(options.initiative);

				// Resolve plans directory based on initiative
				let phasesDir: string;
				if (initiative) {
					phasesDir = join(config.paths.plans, initiative);
				} else {
					phasesDir = config.paths.plans;
				}

				// Normalize phase ID
				const normalizedId = phaseNumber.padStart(2, "0");

				// Find existing phase directory in the initiative-specific phasesDir
				let existingDir: string | null = null;
				if (existsSync(phasesDir)) {
					const dirs = readdirSync(phasesDir);
					existingDir =
						dirs.find((d) => d.startsWith(`${normalizedId}-`)) ?? null;
				}
				if (!existingDir) {
					const errorMsg = `Phase ${normalizedId} not found`;
					if (options.json) {
						console.log(
							JSON.stringify(
								{
									error: errorMsg,
									hint: "Use 'tiller phase list' to see available phases",
								},
								null,
								2,
							),
						);
					} else {
						console.error(`Error: ${errorMsg}`);
						console.error("Use 'tiller phase list' to see available phases");
					}
					process.exit(1);
				}

				// Generate new slug and directory name
				const newSlug = generateSlug(newName.split(/\s+/));
				const newDirName = `${normalizedId}-${newSlug}`;
				const oldPath = join(phasesDir, existingDir);
				const newPath = join(phasesDir, newDirName);

				// Check if already has this name
				if (existingDir === newDirName) {
					if (options.json) {
						console.log(
							JSON.stringify(
								{ status: "unchanged", directory: oldPath },
								null,
								2,
							),
						);
					} else {
						console.log(`Phase ${normalizedId} already has name: ${newSlug}`);
					}
					return;
				}

				// Check if new name conflicts with existing
				if (existsSync(newPath)) {
					const errorMsg = `Directory already exists: ${newPath}`;
					if (options.json) {
						console.log(JSON.stringify({ error: errorMsg }, null, 2));
					} else {
						console.error(`Error: ${errorMsg}`);
					}
					process.exit(1);
				}

				// Dry run: show what would happen
				if (options.dryRun) {
					const changes = {
						dryRun: true,
						from: oldPath,
						to: newPath,
						phase: normalizedId,
						oldName: existingDir.replace(/^\d+(?:\.\d+)?-/, ""),
						newName: newSlug,
					};
					if (options.json) {
						console.log(JSON.stringify(changes, null, 2));
					} else {
						console.log("\n## Phase Rename (dry-run)\n");
						console.log(`Phase: ${normalizedId}`);
						console.log(`From: ${existingDir}`);
						console.log(`To:   ${newDirName}`);
					}
					return;
				}

				// Execute rename
				try {
					renameSync(oldPath, newPath);

					logEvent({
						event: "phase_renamed",
						phase: normalizedId,
						from: existingDir,
						to: newDirName,
					});

					if (options.json) {
						console.log(
							JSON.stringify(
								{
									status: "renamed",
									phase: normalizedId,
									from: existingDir,
									to: newDirName,
								},
								null,
								2,
							),
						);
					} else {
						console.log(
							`✓ Renamed phase ${normalizedId}: ${existingDir} → ${newDirName}`,
						);
					}
				} catch (error) {
					const err = error as NodeJS.ErrnoException;
					if (options.json) {
						console.log(
							JSON.stringify(
								{ error: `Rename failed: ${err.message}` },
								null,
								2,
							),
						);
					} else {
						console.error(`Error: Rename failed: ${err.message}`);
					}
					process.exit(1);
				}
			},
		);

	// tiller phase remove <phase-number>
	phase
		.command("remove <phaseNumber>")
		.description("Remove phase and renumber subsequent phases")
		.option(
			"--confirm",
			"Return TOON for human confirmation instead of executing",
		)
		.option("--dry-run", "Show what would change without modifying")
		.option("--json", "Output as JSON")
		.action(
			(
				phaseNumber: string,
				options: { confirm?: boolean; dryRun?: boolean; json?: boolean },
			) => {
				const config = loadConfig();
				const phasesDir = config.paths.plans;

				// Validate phase exists
				if (!phaseExists(phaseNumber)) {
					console.error(`Error: Phase ${phaseNumber} does not exist`);
					console.error("Use 'tiller phase list' to see available phases");
					process.exit(1);
				}

				// Check for completed work
				if (phaseHasCompletedWork(phaseNumber)) {
					console.error(
						`Error: Phase ${phaseNumber} has completed work (SUMMARY.md files)`,
					);
					console.error("Cannot remove phases with completed work");
					process.exit(1);
				}

				// Check for active work
				if (phaseHasActiveWork(phaseNumber)) {
					console.error(
						`Error: Phase ${phaseNumber} has active runs in progress`,
					);
					console.error("Complete or abandon active runs before removing");
					process.exit(1);
				}

				// Get phases that need renumbering
				const phasesToRenumber = getPhasesToRenumber(phaseNumber);
				const phaseDir = getPhaseDir(phaseNumber);

				// Build renumber map (old -> new)
				const renumberMap = new Map<string, string>();
				for (const p of phasesToRenumber) {
					const oldInt = parsePhaseId(p.id)[0];
					const newInt = oldInt - 1;
					const newId = newInt.toString().padStart(2, "0");
					renumberMap.set(p.id, newId);
				}

				// Show what will happen
				const changes = {
					remove: {
						phaseId: phaseNumber,
						directory: phaseDir ? join(phasesDir, phaseDir) : null,
					},
					renumber: Array.from(renumberMap.entries()).map(([old, newId]) => ({
						from: old,
						to: newId,
						name: phasesToRenumber.find((p) => p.id === old)?.name,
					})),
				};

				if (options.json && options.dryRun) {
					console.log(JSON.stringify({ dryRun: true, ...changes }, null, 2));
					return;
				}

				// --dry-run or --confirm: Show plan without executing
				if (options.dryRun || options.confirm) {
					console.log("\n## Phase Removal Plan\n");
					console.log(`Remove: Phase ${phaseNumber}`);
					if (phaseDir) {
						console.log(`  Directory: ${join(phasesDir, phaseDir)}`);
					}

					if (renumberMap.size > 0) {
						console.log("\nRenumber:");
						for (const [old, newId] of renumberMap) {
							const name = phasesToRenumber.find((p) => p.id === old)?.name;
							console.log(`  ${old} → ${newId} (${name})`);
						}
					}

					if (options.dryRun) {
						console.log("\n--dry-run: No changes made");
					} else {
						console.log(`\nTo execute: \`tiller phase remove ${phaseNumber}\``);
					}
					return;
				}

				// Execute removal and renumbering
				try {
					// 1. Remove phase directory (if exists)
					if (phaseDir) {
						const { rmSync } = require("node:fs");
						rmSync(join(phasesDir, phaseDir), { recursive: true });
					}

					// 2. Remove phase from ROADMAP.md
					try {
						removePhaseSection(phaseNumber);
					} catch (err) {
						console.error(`Warning: Could not update ROADMAP.md: ${err}`);
					}

					// 3. Renumber subsequent phases (in reverse order to avoid conflicts)
					const sortedRenumber = Array.from(renumberMap.entries()).sort(
						(a, b) => parseInt(b[0], 10) - parseInt(a[0], 10),
					);

					for (const [oldId, newId] of sortedRenumber) {
						// Rename directory and files
						renamePhaseDir(oldId, newId);

						// Update frontmatter in plan files
						const newDir = getPhaseDir(newId);
						if (newDir) {
							updatePlanFrontmatter(newDir, oldId, newId);
						}
					}

					// 4. Update ROADMAP.md references
					if (renumberMap.size > 0) {
						renumberRoadmapReferences(renumberMap);
						updatePhaseChecklist(renumberMap);
					}

					// Output result
					if (options.json) {
						console.log(
							JSON.stringify(
								{
									action: "removed",
									...changes,
								},
								null,
								2,
							),
						);
						return;
					}

					console.log(`\n✓ Removed phase ${phaseNumber}`);
					if (renumberMap.size > 0) {
						console.log(`✓ Renumbered ${renumberMap.size} subsequent phases`);
					}
					console.log("\nNext steps:");
					console.log("  1. Review ROADMAP.md for any manual adjustments");
					console.log("  2. Commit changes: git add .planning/ && git commit");
				} catch (err) {
					console.error(`Error during phase removal: ${err}`);
					console.error("Some changes may have been partially applied");
					process.exit(1);
				}
			},
		);

	// tiller phase insert-before <N> - shift phases >= N up by 1
	phase
		.command("insert-before <phaseNumber>")
		.description("Shift all phases >= N up by 1 (make room for a new root phase)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--dry-run", "Show what would change without modifying")
		.option("-y, --force", "Execute without confirmation")
		.action(
			(
				phaseNumber: string,
				options: { initiative?: string; dryRun?: boolean; force?: boolean },
			) => {
				const config = loadConfig();
				const initiative = resolveInitiative(options.initiative);

				// Resolve plans directory based on initiative
				let phasesDir: string;
				if (initiative) {
					phasesDir = join(config.paths.plans, initiative);
				} else {
					phasesDir = config.paths.plans;
				}

				if (!existsSync(phasesDir)) {
					console.error(`No phases directory: ${phasesDir}`);
					process.exit(1);
				}

				// Get all phases >= N (only integer phases, no decimals)
				const targetInt = parsePhaseId(phaseNumber)[0];
				const dirs = readdirSync(phasesDir, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name);

				const phasesToShift: Array<{ id: string; name: string; dir: string }> = [];
				for (const dir of dirs) {
					const match = dir.match(/^(\d+)-(.+)$/);
					if (match) {
						const phaseInt = parseInt(match[1], 10);
						if (phaseInt >= targetInt) {
							phasesToShift.push({
								id: match[1].padStart(2, "0"),
								name: match[2],
								dir,
							});
						}
					}
				}

				// Sort descending (shift from highest first to avoid conflicts)
				phasesToShift.sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));

				// Build shift map (old -> new)
				const shiftMap = new Map<string, string>();
				for (const p of phasesToShift) {
					const oldInt = parseInt(p.id, 10);
					const newId = (oldInt + 1).toString().padStart(2, "0");
					shiftMap.set(p.id, newId);
				}

				// Show plan
				console.log("\n## Phase Insert-Before Plan\n");
				console.log(`Insert before: Phase ${phaseNumber}`);
				console.log(`Initiative: ${initiative || "(default)"}`);
				console.log(`\nShifts (${shiftMap.size} phases):`);
				for (const [oldId, newId] of shiftMap) {
					const p = phasesToShift.find((x) => x.id === oldId);
					console.log(`  ${oldId} → ${newId}  (${p?.name})`);
				}

				if (options.dryRun) {
					console.log("\n(dry run - no changes made)");
					return;
				}

				if (!options.force) {
					console.log("\nUse --force/-y to execute, or --dry-run to preview");
					return;
				}

				// Execute shifts (in descending order to avoid conflicts)
				try {
					for (const [oldId, newId] of shiftMap) {
						renamePhaseDir(oldId, newId);
						const newDir = getPhaseDir(newId);
						if (newDir) {
							updatePlanFrontmatter(newDir, oldId, newId);
						}
					}

					console.log(`\n✓ Shifted ${shiftMap.size} phases`);
					console.log(`\nPhase ${phaseNumber} is now available for creation.`);
					console.log(`Next: tiller phase create ${phaseNumber} "<name>"`);
				} catch (err) {
					console.error(`Error during shift: ${err}`);
					process.exit(1);
				}
			},
		);

	// tiller phase renumber - collapse gaps
	phase
		.command("renumber")
		.description("Collapse gaps in phase numbering (01, 03, 05 → 01, 02, 03)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--dry-run", "Show what would change without modifying")
		.option("-y, --force", "Execute without confirmation")
		.action(
			(options: { initiative?: string; dryRun?: boolean; force?: boolean }) => {
				const config = loadConfig();
				const initiative = resolveInitiative(options.initiative);

				// Resolve plans directory based on initiative
				let phasesDir: string;
				if (initiative) {
					phasesDir = join(config.paths.plans, initiative);
				} else {
					phasesDir = config.paths.plans;
				}

				if (!existsSync(phasesDir)) {
					console.error(`No phases directory: ${phasesDir}`);
					process.exit(1);
				}

				// Get all integer phases (no decimals), sorted
				const dirs = readdirSync(phasesDir, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name);

				const intPhases: Array<{ id: string; name: string; dir: string }> = [];
				for (const dir of dirs) {
					const match = dir.match(/^(\d+)-(.+)$/);
					if (match) {
						intPhases.push({
							id: match[1].padStart(2, "0"),
							name: match[2],
							dir,
						});
					}
				}

				// Sort ascending by phase number
				intPhases.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

				// Build renumber map (assign sequential numbers starting from 01)
				const renumberMap = new Map<string, string>();
				let nextNum = 1;
				for (const p of intPhases) {
					const newId = nextNum.toString().padStart(2, "0");
					if (p.id !== newId) {
						renumberMap.set(p.id, newId);
					}
					nextNum++;
				}

				if (renumberMap.size === 0) {
					console.log("No gaps to collapse - phases are already sequential.");
					return;
				}

				// Show plan
				console.log("\n## Phase Renumber Plan\n");
				console.log(`Initiative: ${initiative || "(default)"}`);
				console.log(`\nRenumber (${renumberMap.size} phases):`);
				for (const [oldId, newId] of renumberMap) {
					const p = intPhases.find((x) => x.id === oldId);
					console.log(`  ${oldId} → ${newId}  (${p?.name})`);
				}

				if (options.dryRun) {
					console.log("\n(dry run - no changes made)");
					return;
				}

				if (!options.force) {
					console.log("\nUse --force/-y to execute, or --dry-run to preview");
					return;
				}

				// Execute renumbering (in descending order to avoid conflicts)
				try {
					const sortedRenumber = Array.from(renumberMap.entries()).sort(
						(a, b) => parseInt(b[0], 10) - parseInt(a[0], 10),
					);

					for (const [oldId, newId] of sortedRenumber) {
						renamePhaseDir(oldId, newId);
						const newDir = getPhaseDir(newId);
						if (newDir) {
							updatePlanFrontmatter(newDir, oldId, newId);
						}
					}

					console.log(`\n✓ Renumbered ${renumberMap.size} phases`);
					console.log("\nPhases are now sequential.");
				} catch (err) {
					console.error(`Error during renumber: ${err}`);
					process.exit(1);
				}
			},
		);

	// tiller phase absorb-decimals - integrate decimal phases
	phase
		.command("absorb-decimals")
		.description("Integrate decimal phases into sequential numbering (07, 07.1, 08 → 07, 08, 09)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--dry-run", "Show what would change without modifying")
		.option("-y, --force", "Execute without confirmation")
		.action(
			(options: { initiative?: string; dryRun?: boolean; force?: boolean }) => {
				const config = loadConfig();
				const initiative = resolveInitiative(options.initiative);

				// Resolve plans directory based on initiative
				let phasesDir: string;
				if (initiative) {
					phasesDir = join(config.paths.plans, initiative);
				} else {
					phasesDir = config.paths.plans;
				}

				if (!existsSync(phasesDir)) {
					console.error(`No phases directory: ${phasesDir}`);
					process.exit(1);
				}

				// Get all phases (including decimals), sorted
				const dirs = readdirSync(phasesDir, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name);

				const allPhases: Array<{ id: string; name: string; dir: string; isDecimal: boolean }> = [];
				for (const dir of dirs) {
					const matchInt = dir.match(/^(\d+)-(.+)$/);
					const matchDec = dir.match(/^(\d+\.\d+)-(.+)$/);
					if (matchDec) {
						allPhases.push({
							id: matchDec[1],
							name: matchDec[2],
							dir,
							isDecimal: true,
						});
					} else if (matchInt) {
						allPhases.push({
							id: matchInt[1].padStart(2, "0"),
							name: matchInt[2],
							dir,
							isDecimal: false,
						});
					}
				}

				// Sort by phase ID (handles decimals correctly)
				allPhases.sort((a, b) => comparePhaseIds(a.id, b.id));

				// Check for decimal phases
				const hasDecimals = allPhases.some((p) => p.isDecimal);
				if (!hasDecimals) {
					console.log("No decimal phases to absorb.");
					return;
				}

				// Build renumber map (assign sequential integers)
				const renumberMap = new Map<string, string>();
				let nextNum = 1;
				for (const p of allPhases) {
					const newId = nextNum.toString().padStart(2, "0");
					if (p.id !== newId) {
						renumberMap.set(p.id, newId);
					}
					nextNum++;
				}

				// Show plan
				console.log("\n## Phase Absorb-Decimals Plan\n");
				console.log(`Initiative: ${initiative || "(default)"}`);
				console.log(`\nRenumber (${renumberMap.size} phases):`);
				for (const p of allPhases) {
					const newId = renumberMap.get(p.id) || p.id;
					const marker = p.isDecimal ? " (decimal)" : "";
					if (p.id !== newId) {
						console.log(`  ${p.id} → ${newId}  (${p.name})${marker}`);
					} else {
						console.log(`  ${p.id}       (${p.name}) - unchanged`);
					}
				}

				if (options.dryRun) {
					console.log("\n(dry run - no changes made)");
					return;
				}

				if (!options.force) {
					console.log("\nUse --force/-y to execute, or --dry-run to preview");
					return;
				}

				// Execute absorption - rename from highest to lowest to avoid conflicts
				try {
					// Sort by original ID descending (process highest first)
					const sortedRenumber = Array.from(renumberMap.entries()).sort(
						(a, b) => comparePhaseIds(b[0], a[0]),
					);

					for (const [oldId, newId] of sortedRenumber) {
						renamePhaseDir(oldId, newId);
						const newDir = getPhaseDir(newId);
						if (newDir) {
							updatePlanFrontmatter(newDir, oldId, newId);
						}
					}

					console.log(`\n✓ Absorbed decimal phases`);
					console.log(`✓ Renumbered ${renumberMap.size} phases to sequential integers`);
				} catch (err) {
					console.error(`Error during absorption: ${err}`);
					process.exit(1);
				}
			},
		);
}

/**
 * Display detailed phase info
 */
function displayPhaseInfo(info: PhaseInfo): void {
	const symbol = getPhaseStateSymbol(info.state);
	console.log(`\n${symbol} Phase ${info.id}: ${info.name}`);
	console.log(
		`State: ${info.state} (derived from ${info.tracks.length} tracks)`,
	);

	if (info.progress.total > 0) {
		console.log(
			`Progress: ${info.progress.complete}/${info.progress.total} complete`,
		);
	}

	if (info.completed_at) {
		console.log(`Completed: ${info.completed_at}`);
	}

	if (info.tracks.length > 0) {
		console.log("\nRuns:");
		for (const track of info.tracks) {
			const runSymbol = track.state === "complete" ? "✓" : "○";
			// Extract plan number
			const planMatch = track.plan_path.match(/(\d+)-PLAN\.md$/);
			const planNum = planMatch ? planMatch[1] : "?";
			console.log(`  ${runSymbol} ${track.id}: ${track.state}`);
			console.log(`    Plan: ${info.id}-${planNum}`);
			if (track.intent) {
				const shortIntent =
					track.intent.length > 50
						? `${track.intent.slice(0, 47)}...`
						: track.intent;
				console.log(`    Intent: ${shortIntent}`);
			}
		}
	}
	console.log("");
}
