/**
 * Tiller collect command - Triage orphaned beads into plans or todos
 *
 * Design from 06.6-05 discussion:
 * - bd is powerful standalone - agents use directly
 * - tiller collect is the bridge when beads need structured planning
 * - Not wrapping, parallel with collection as integration point
 *
 * Orphan = bead without valid plan:* label and without backlog label
 * NOTE: A plan:* label is only valid if the referenced PLAN.md file exists.
 * This prevents stale labels from hiding orphaned beads.
 *
 * Triage options:
 * - needs-plan → create PLAN.md, add plan:<ref> label (multi-session, needs verification)
 * - needs-todo → create todo in .planning/todos/pending/ (quick fix, single session)
 * - backlog → add backlog label (excluded from future triage)
 * - skip → leave for later
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig, getConfigPaths } from "../state/config.js";
import { getCurrentPhase, getNextPlanNumberInDir } from "./plan.js";

// ============================================================================
// Types
// ============================================================================

interface Bead {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type: string;
	labels?: string[];
}

// ============================================================================
// Orphan Detection
// ============================================================================

function getBeadLabels(beadId: string): string[] {
	try {
		const output = execSync(`bd label list ${beadId} --json 2>/dev/null`, {
			encoding: "utf-8",
		});
		const labels = JSON.parse(output);
		return Array.isArray(labels) ? labels : [];
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(
				`[tiller collect] getBeadLabels(${beadId}) error: ${(e as Error).message}`,
			);
		}
		return [];
	}
}

/**
 * Check if a plan file exists for the given plan reference.
 * A bead with a plan:* label but no actual plan file is still an orphan.
 *
 * Searches across all initiatives under plans/{initiative}/{phase}/ per ADR-0005.
 */
function planFileExists(planRef: string): boolean {
	// Extract phase ID from plan ref (e.g., "06.6-25" -> "06.6", "01-03" -> "01")
	const match = planRef.match(/^(\d+(?:\.\d+)?)-\d+$/);
	if (!match) return false;

	const phaseId = match[1];
	const config = loadConfig();
	const plansDir = config.paths.plans;

	if (!existsSync(plansDir)) return false;

	// Search across all initiative directories
	const entries = readdirSync(plansDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

		const initPath = join(plansDir, entry.name);
		try {
			const phaseDirs = readdirSync(initPath, { withFileTypes: true });
			const phaseDir = phaseDirs.find(
				(d) => d.isDirectory() && d.name.startsWith(`${phaseId}-`),
			);
			if (phaseDir) {
				const planPath = join(initPath, phaseDir.name, `${planRef}-PLAN.md`);
				if (existsSync(planPath)) return true;
			}
		} catch {
			// Skip unreadable directories
		}
	}

	return false;
}

function findOrphanedBeads(): Bead[] {
	try {
		// Get all open issues
		const output = execSync("bd list --status=open --json --limit=0", {
			encoding: "utf-8",
		});
		const allBeads: Bead[] = JSON.parse(output);

		// Filter orphans:
		// - no valid plan:* label (either missing or references non-existent plan)
		// - AND no backlog label
		// - AND no todo label
		const orphans: Bead[] = [];
		for (const bead of allBeads) {
			const labels = getBeadLabels(bead.id);
			const hasBacklogLabel = labels.includes("backlog");
			const hasTodoLabel = labels.includes("todo");

			// Check for valid plan label (label exists AND plan file exists)
			const planLabel = labels.find((l) => l.startsWith("plan:"));
			const hasValidPlanLabel = planLabel
				? planFileExists(planLabel.replace("plan:", ""))
				: false;

			if (!hasValidPlanLabel && !hasBacklogLabel && !hasTodoLabel) {
				bead.labels = labels;
				orphans.push(bead);
			}
		}

		return orphans;
	} catch (e) {
		console.error(`Error listing beads: ${(e as Error).message}`);
		return [];
	}
}

// ============================================================================
// Plan Creation
// ============================================================================

interface CreateOptions {
	force?: boolean;
	phasesDir?: string;
}

interface CreateResult {
	ref: string;
	path: string;
	skipped?: boolean;
	reason?: string;
}

function createPlanFromBead(
	bead: Bead,
	phaseId: string,
	opts: CreateOptions = {},
): CreateResult {
	// Check for existing plan:* labels (even stale ones)
	const existingPlanLabel = bead.labels?.find((l) => l.startsWith("plan:"));
	if (existingPlanLabel && !opts.force) {
		return {
			ref: "",
			path: "",
			skipped: true,
			reason: `already has label ${existingPlanLabel}`,
		};
	}

	// Remove stale plan label if forcing
	if (existingPlanLabel && opts.force) {
		try {
			execSync(`bd label remove ${bead.id} ${existingPlanLabel}`, {
				stdio: "pipe",
			});
		} catch (e) {
			if (process.env.TILLER_DEBUG) {
				console.error(
					`[tiller collect] label remove failed for ${bead.id}: ${(e as Error).message}`,
				);
			}
			// Continue anyway - the label might not exist
		}
	}
	// Find actual phase directory FIRST
	const phasesDir = opts.phasesDir || "plans";
	if (!existsSync(phasesDir)) {
		throw new Error(`Plans directory not found: ${phasesDir}`);
	}
	const dirs = readdirSync(phasesDir);
	const phaseDir = dirs.find((d) => d.startsWith(`${phaseId}-`));
	if (!phaseDir) {
		throw new Error(`Phase not found: ${phaseId} in ${phasesDir}`);
	}

	// Now calculate plan number from the CORRECT directory
	const fullPath = join(phasesDir, phaseDir);
	const planNumber = getNextPlanNumberInDir(fullPath, phaseId);
	const paddedNum = planNumber.toString().padStart(2, "0");
	const planRef = `${phaseId}-${paddedNum}`;

	const planPath = join(phasesDir, phaseDir, `${planRef}-PLAN.md`);

	const content = `---
title: "${bead.title.replace(/"/g, '\\"')}"
phase: ${phaseId}
plan: ${planNumber}
type: execute
bead_ref: ${bead.id}
autonomous: true
---

<objective>
${bead.title}

Imported from bead ${bead.id}
</objective>

<context>
Original type: ${bead.issue_type}
Priority: P${bead.priority}
</context>

<!-- EXPAND: Run \`tiller plan expand ${planRef}\` to break down tasks -->
<tasks>
</tasks>

<verification>
- [ ] \`tsc --noEmit\` passes
</verification>
<!-- END EXPAND -->
`;

	writeFileSync(planPath, content);

	// Add plan label to bead
	try {
		execSync(`bd label add ${bead.id} plan:${planRef}`, { stdio: "pipe" });
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(
				`[tiller collect] label add failed for ${bead.id}: ${(e as Error).message}`,
			);
		}
		// Continue - label might already exist
	}

	return { ref: planRef, path: planPath, skipped: false };
}

// ============================================================================
// Todo Creation
// ============================================================================

interface TodoResult {
	path: string;
	skipped?: boolean;
	reason?: string;
}

function createTodoFromBead(bead: Bead, opts: CreateOptions = {}): TodoResult {
	// Check for existing plan:* labels (even stale ones)
	const existingPlanLabel = bead.labels?.find((l) => l.startsWith("plan:"));
	if (existingPlanLabel && !opts.force) {
		return {
			path: "",
			skipped: true,
			reason: `already has label ${existingPlanLabel}`,
		};
	}

	// Remove stale plan label if forcing
	if (existingPlanLabel && opts.force) {
		try {
			execSync(`bd label remove ${bead.id} ${existingPlanLabel}`, {
				stdio: "pipe",
			});
		} catch (e) {
			if (process.env.TILLER_DEBUG) {
				console.error(
					`[tiller collect] todo label remove failed for ${bead.id}: ${(e as Error).message}`,
				);
			}
			// Continue anyway - the label might not exist
		}
	}

	const { TODOS_DIR } = getConfigPaths();
	const todosDir = join(TODOS_DIR, "pending");
	mkdirSync(todosDir, { recursive: true });

	// Generate filename: YYYY-MM-DD-slug.md
	const now = new Date();
	const date = now.toISOString().split("T")[0];
	const slug = bead.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
	const todoPath = join(todosDir, `${date}-${slug}.md`);

	const content = `---
created: ${now.toISOString().slice(0, 16)}
title: "${bead.title.replace(/"/g, '\\"')}"
area: ${bead.issue_type}
beads_task: ${bead.id}
---

## Problem

${bead.title}

Imported from bead ${bead.id} (P${bead.priority})

## Solution

<!-- TODO: Describe the fix -->
`;

	writeFileSync(todoPath, content);

	// Add todo label to bead
	try {
		execSync(`bd label add ${bead.id} todo`, { stdio: "pipe" });
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(
				`[tiller collect] todo label add failed for ${bead.id}: ${(e as Error).message}`,
			);
		}
		// Continue - label might already exist
	}

	return { path: todoPath, skipped: false };
}

// ============================================================================
// Initiative Discovery
// ============================================================================

interface InitiativeInfo {
	name: string;
	phaseCount: number;
	planCount: number;
}

function getAvailableInitiatives(plansDir: string): InitiativeInfo[] {
	if (!existsSync(plansDir)) return [];

	const entries = readdirSync(plansDir, { withFileTypes: true });
	const initiatives: InitiativeInfo[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		// Skip special directories
		if (entry.name.startsWith(".") || entry.name === "archive") continue;

		const initPath = join(plansDir, entry.name);
		const subEntries = readdirSync(initPath, { withFileTypes: true });

		// Count phases (directories matching XX- or XX.X- pattern)
		const phases = subEntries.filter(
			(e) => e.isDirectory() && /^\d+(\.\d+)?-/.test(e.name),
		);

		// Count plans across all phases
		let planCount = 0;
		for (const phase of phases) {
			const phasePath = join(initPath, phase.name);
			const plans = readdirSync(phasePath).filter((f) =>
				f.endsWith("-PLAN.md"),
			);
			planCount += plans.length;
		}

		if (phases.length > 0) {
			initiatives.push({
				name: entry.name,
				phaseCount: phases.length,
				planCount,
			});
		}
	}

	return initiatives;
}

// ============================================================================
// Command Implementation
// ============================================================================

export function registerCollectCommand(program: Command): void {
	program
		.command("collect")
		.description("Triage orphaned beads into plans or todos")
		.argument("[bead-id]", "Specific bead ID to collect")
		.option("--all", "Collect all orphaned beads (batch mode)")
		.option("--triage", "Interactive triage mode - go through orphans one-by-one")
		.option("--human", "Interactive mode - output TOON for per-item decisions (deprecated, use --triage)")
		.option(
			"--phase <id>",
			"Target phase for new plans (default: current active)",
		)
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--plan", "Create plans (default behavior, explicit for clarity)")
		.option("--todo", "Create todos instead of plans (for quick fixes)")
		.option("--dry-run", "Show what would be collected without creating")
		.option("--force", "Override existing plan:* labels (removes stale labels)")
		.option("--json", "Output as JSON")
		.addHelpText(
			"after",
			`
Examples:
  $ tiller collect tiller-xyz --phase 06.6
    Collect single bead into phase 06.6

  $ tiller collect --triage
    Interactive triage mode - process orphans one-by-one

  $ tiller collect --all --phase 06.6
    Batch collect all orphans into phase 06.6

  $ tiller collect tiller-abc --todo
    Create todo instead of plan for quick fixes

Modes:
  Single-bead: Collect one specific bead by ID
  Triage:      Loop through orphans interactively
  Batch:       Collect all orphans at once (requires --all)
`,
		)
		.action(
			(
				beadId: string | undefined,
				opts: {
					all?: boolean;
					triage?: boolean;
					human?: boolean;
					phase?: string;
					initiative?: string;
					plan?: boolean;
					todo?: boolean;
					dryRun?: boolean;
					force?: boolean;
					json?: boolean;
				},
			) => {
				// Validate: must provide bead-id, --all, or --triage
				if (!beadId && !opts.all && !opts.triage && !opts.human) {
					console.error("Error: Must provide either:");
					console.error("  - A bead ID: tiller collect <bead-id>");
					console.error("  - --all flag: tiller collect --all");
					console.error("  - --triage flag: tiller collect --triage");
					console.error("\nRun 'tiller collect --help' for examples.");
					process.exit(1);
				}

				const config = loadConfig();
				let orphans = findOrphanedBeads();

				// Single-bead mode: validate and filter to just that bead
				if (beadId) {
					const bead = orphans.find((o) => o.id === beadId);
					if (!bead) {
						console.error(`Error: Bead "${beadId}" not found or not orphaned.`);
						console.error("\nA bead is orphaned if it:");
						console.error("  - Has no valid plan:* label");
						console.error("  - Has no backlog label");
						console.error("  - Has no todo label");
						process.exit(1);
					}
					orphans = [bead];
				}

				if (orphans.length === 0) {
					if (opts.json) {
						console.log(
							JSON.stringify({
								orphans: [],
								message: "No orphaned beads found",
							}),
						);
					} else {
						console.log("✓ No orphaned beads found");
						console.log(
							"  All beads are either linked to plans or marked as backlog.",
						);
					}
					return;
				}

				// Determine phasesDir based on initiative
				// Check for initiative ambiguity first
				const initiatives = getAvailableInitiatives(config.paths.plans);
				let phasesDir: string;
				let resolvedInitiative: string | undefined;

				if (opts.initiative) {
					// Explicit --initiative flag
					phasesDir = join(config.paths.plans, opts.initiative);
					resolvedInitiative = opts.initiative;
				} else if (config.workflow?.current_initiative) {
					// Config has current initiative
					phasesDir = join(config.paths.plans, config.workflow.current_initiative);
					resolvedInitiative = config.workflow.current_initiative;
				} else if (initiatives.length > 1) {
					// AMBIGUOUS: multiple initiatives, none specified
					// Output TOON guidance for agent to decide
					console.log(`\`\`\`toon
collect_initiative_required:
  orphan_count: ${orphans.length}
  available_initiatives:
${initiatives.map((i) => `    - name: "${i.name}"
      phases: ${i.phaseCount}
      plans: ${i.planCount}`).join("\n")}
  orphans:
${orphans.map((o) => `    - id: "${o.id}"
      title: "${o.title.replace(/"/g, '\\"')}"
      type: ${o.issue_type}`).join("\n")}
\`\`\`

## Agent Guidance: Initiative Selection Required

Multiple initiatives exist. Analyze each bead's context to determine the appropriate initiative:

**Selection criteria:**
- **dogfooding**: Issues discovered while using tiller itself (meta, internal)
- **tiller-cli**: Feature work, CLI improvements, user-facing changes
- Other initiatives: Match bead content to initiative purpose

**Actions:**
1. For each bead, determine which initiative it belongs to
2. Group beads by initiative
3. Run separate collect commands:
   \`\`\`bash
   tiller collect <bead-ids...> --phase <phase> --initiative <name>
   \`\`\`

**Tip:** If all beads belong to same initiative, collect them together.
If beads span initiatives, run multiple collect commands.`);
					return;
				} else if (initiatives.length === 1) {
					// Single initiative, use it
					phasesDir = join(config.paths.plans, initiatives[0].name);
					resolvedInitiative = initiatives[0].name;
				} else {
					// No initiatives (flat plans dir)
					phasesDir = config.paths.plans;
				}

				// Determine target phase
				let targetPhase: string;
				if (opts.phase) {
					targetPhase = opts.phase;
				} else {
					const current = getCurrentPhase();
					if (current) {
						targetPhase = current;
					} else {
						console.error("No active phase. Specify --phase <id>");
						process.exit(1);
					}
				}

				// Triage mode: loop through orphans one-by-one
				if (opts.triage) {
					console.log(`\`\`\`toon
collect_triage_mode:
  orphan_count: ${orphans.length}
  target_phase: "${targetPhase}"
  target_initiative: "${resolvedInitiative || 'none'}"
  orphans:
${orphans
	.map(
		(o, idx) => `    - index: ${idx}
      id: "${o.id}"
      title: "${o.title.replace(/"/g, '\\"')}"
      type: ${o.issue_type}
      priority: P${o.priority}`,
	)
	.join("\n")}
\`\`\`

## Interactive Triage Mode

Process each orphan bead one-by-one. For each bead:

**Step 1: Search for duplicates**
\`\`\`bash
grep -rl "KEYWORD" ${phasesDir}/*/*.md | head -5
\`\`\`

**Step 2: Categorize the bead**
- **plan** - Multi-session work needing verification → create plan in ${targetPhase}
- **todo** - Quick fix, single session → create todo file
- **backlog** - Valid but low priority → mark with backlog label
- **skip** - Leave for later (no action)
- **close-duplicate** - Duplicates existing plan → close the bead
- **close-done** - Work already complete → close the bead

**Step 3: Execute action for current bead**
Use one of these commands based on your decision:

\`\`\`bash
# Create plan
tiller collect ${orphans[0].id} --phase ${targetPhase}${resolvedInitiative ? ` --initiative ${resolvedInitiative}` : ""}

# Create todo
tiller collect ${orphans[0].id} --todo

# Mark as backlog
bd label add ${orphans[0].id} backlog

# Close as duplicate/done
bd close ${orphans[0].id} --reason="your reason"

# Skip (do nothing, move to next)
\`\`\`

**Step 4: Repeat for remaining beads**
After handling the first bead, run: \`tiller collect --triage\` again
The processed bead will no longer appear in the orphan list.

**Progress: 0/${orphans.length} triaged**`);
					return;
				}

				// Human mode: output TOON for interactive triage (deprecated, use --triage instead)
				if (opts.human) {
					console.log(`\`\`\`toon
collect_triage:
  orphan_count: ${orphans.length}
  target_phase: "${targetPhase}"
  orphans:
${orphans
	.map(
		(o) => `    - id: "${o.id}"
      title: "${o.title.replace(/"/g, '\\"')}"
      type: ${o.issue_type}
      priority: P${o.priority}
      stale_labels: ${JSON.stringify(o.labels?.filter((l) => l.startsWith("plan:")) || [])}`,
	)
	.join("\n")}
\`\`\`

## Triage Protocol

For each orphan, determine its disposition:

### Step 1: Check for duplicate plans
Search \`.planning/phases/\` for plans with matching intent:
\`\`\`bash
grep -rl "KEYWORD" .planning/phases/*/*.md | head -5
\`\`\`

### Step 2: Check completion status
If a matching plan exists, check for SUMMARY.md:
- Has SUMMARY → bead is **done**, close it
- No SUMMARY → bead **duplicates open plan**, close as duplicate

### Step 3: Categorize
- **close-done**: Duplicates completed plan (has SUMMARY)
- **close-duplicate**: Duplicates open plan (no SUMMARY)
- **needs-plan**: Multi-session work needing verification → create plan in phase ${targetPhase}
- **needs-todo**: Quick fix, single session → create todo in .planning/todos/pending/
- **backlog**: Valid but low priority, mark as backlog

### Step 4: Present to user
Use AskUserQuestion with categories as options. Include your analysis.

### Step 5: Execute
- Close beads: \`bd close <id> --reason="..."\`
- Backlog beads: \`bd label add <id> backlog\`
- Create plans: \`tiller collect --phase ${targetPhase}\` (for needs-plan items)
- Create todos: \`tiller collect --todo\` (for needs-todo items)

Note: Stale labels indicate beads that previously had plan:* labels pointing to non-existent plans.`);
					return;
				}

				// Dry-run: show what would happen
				if (opts.dryRun) {
					if (opts.json) {
						console.log(
							JSON.stringify({
								orphans: orphans.map((o) => ({
									id: o.id,
									title: o.title,
									type: o.issue_type,
									priority: o.priority,
									would_create: `${targetPhase}-XX-PLAN.md`,
								})),
								target_phase: targetPhase,
							}),
						);
					} else {
						console.log(`Found ${orphans.length} orphaned bead(s):\n`);
						for (const o of orphans) {
							console.log(`  ${o.id}: ${o.title}`);
							console.log(
								`    type: ${o.issue_type}, priority: P${o.priority}`,
							);
						}
						console.log(`\nWould collect into phase: ${targetPhase}`);
						console.log("\nRun without --dry-run to create plans.");
					}
					return;
				}

				// Todo mode: create todos instead of plans
				if (opts.todo) {
					const created: { bead: Bead; path: string }[] = [];
					const skipped: { bead: Bead; reason: string }[] = [];
					const errored: Bead[] = [];

					console.log(`Creating ${orphans.length} todo(s)...\n`);

					for (const bead of orphans) {
						try {
							const result = createTodoFromBead(bead, { force: opts.force });
							if (result.skipped) {
								skipped.push({ bead, reason: result.reason || "unknown" });
								console.log(`  ⊘ ${bead.id}: ${result.reason}`);
								console.log(`    ${bead.title}`);
							} else {
								created.push({ bead, path: result.path });
								console.log(`  ✓ ${bead.id} → ${result.path}`);
								console.log(`    ${bead.title}`);
							}
						} catch (e) {
							console.error(`  ✗ ${bead.id}: ${(e as Error).message}`);
							errored.push(bead);
						}
					}

					if (opts.json) {
						console.log(JSON.stringify({ created, skipped, errored }, null, 2));
					} else {
						console.log(`\nCreated ${created.length} todo(s).`);
						if (skipped.length > 0) {
							console.log(
								`Skipped ${skipped.length} (have existing plan labels). Use --force to override.`,
							);
						}
						if (errored.length > 0) {
							console.log(`Errored ${errored.length} due to other failures.`);
						}
						console.log(
							"\nNext: Work the todos, then run `tiller todo sync` to mark done",
						);
					}
					return;
				}

				// Batch collection requires --all flag (unless single bead specified)
				if (!beadId && orphans.length > 1 && !opts.all) {
					console.error(`Error: Batch collection requires --all flag.`);
					console.error(`\nFound ${orphans.length} orphaned beads. Use one of:`);
					console.error(`  - tiller collect --all --phase ${targetPhase}  # Collect all at once`);
					console.error(`  - tiller collect --triage                       # Interactive triage`);
					console.error(`  - tiller collect <bead-id> --phase ${targetPhase}  # Single bead`);
					process.exit(1);
				}

				// Batch or single-bead collection: auto-collect orphans into target phase as plans
				const collected: { bead: Bead; planRef: string; planPath: string }[] =
					[];
				const skipped: { bead: Bead; reason: string }[] = [];
				const errored: Bead[] = [];

				const targetDisplay = resolvedInitiative
					? `${resolvedInitiative}/${targetPhase}`
					: targetPhase;
				const modeDesc = beadId ? "single bead" : `${orphans.length} orphan(s)`;
				console.log(
					`Collecting ${modeDesc} into ${targetDisplay}...\n`,
				);

				for (const bead of orphans) {
					try {
						const result = createPlanFromBead(bead, targetPhase, {
							force: opts.force,
							phasesDir,
						});
						if (result.skipped) {
							skipped.push({ bead, reason: result.reason || "unknown" });
							console.log(`  ⊘ ${bead.id}: ${result.reason}`);
							console.log(`    ${bead.title}`);
						} else {
							collected.push({
								bead,
								planRef: result.ref,
								planPath: result.path,
							});
							console.log(`  ✓ ${result.ref} ← ${bead.id}`);
							console.log(`    ${bead.title}`);
						}
					} catch (e) {
						console.error(`  ✗ ${bead.id}: ${(e as Error).message}`);
						errored.push(bead);
					}
				}

				if (opts.json) {
					console.log(
						JSON.stringify({ orphans, collected, skipped, errored }, null, 2),
					);
				} else {
					console.log(`\nCollected ${collected.length} bead(s) into plans.`);
					if (skipped.length > 0) {
						console.log(
							`Skipped ${skipped.length} (have existing plan labels). Use --force to override.`,
						);
					}
					if (errored.length > 0) {
						console.log(`Errored ${errored.length} due to other failures.`);
					}
					console.log(
						"\nNext: tiller init <phase> to create runs from plans",
					);
				}
			},
		);
}
