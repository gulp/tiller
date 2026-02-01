/**
 * Plan management commands
 *
 * - tiller plan next: Get next sequential plan number (max + 1)
 * - tiller plan create: Create new plan with template
 * - tiller plan list: List plans in phase
 * - tiller plan show: Show plan details
 *
 * Note: `tiller start <ref>` handles collapsed lifecycle at root level
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../state/config.js";
import { resolveInitiative, getWorkingInitiative, hasExplicitFocus, resolvePhasesDir } from "../state/initiative.js";
import { listInitiatives } from "./initiative.js";
import { getAllPhases, getPhaseInfo } from "../state/phase.js";
import {
	createRun,
	getRunPlanRef,
	listRuns,
	resolveRunRef,
	saveRun,
} from "../state/run.js";
import { matchState } from "../types/index.js";
import { outputTOON } from "../types/toon.js";

// Context placeholder - only matches if it's the entire context content
const CONTEXT_PLACEHOLDER = "Background and constraints.";

// Task placeholder patterns - must be exact template matches
const TASK_PLACEHOLDERS = [
	"<name>Task 1: Description</name>",
	"<files>files/to/modify</files>",
	"What to do.\n  </action>",
];

// Verification placeholder
const VERIFY_PLACEHOLDER = "- [ ] Acceptance criteria";

interface SectionAnalysis {
	name: string;
	status: "todo" | "partial" | "complete";
	hint: string;
}

/**
 * Analyze plan content for incomplete sections
 */
function analyzePlanSections(content: string): SectionAnalysis[] {
	const sections: SectionAnalysis[] = [];

	// Check for explicit expansion marker (HTML comment form)
	// Support both old TODO: and new EXPAND: formats
	const hasTodoMarker =
		(content.includes("<!-- TODO:") && content.includes("<!-- END TODO -->")) ||
		(content.includes("<!-- EXPAND:") && content.includes("<!-- END EXPAND -->"));

	// Analyze <context> section
	const contextMatch = content.match(/<context>([\s\S]*?)<\/context>/);
	if (contextMatch) {
		const contextContent = contextMatch[1].trim();
		// Context is placeholder if it matches exactly or is very short
		const isPlaceholder = contextContent === CONTEXT_PLACEHOLDER;
		const isMinimal = contextContent.length < 50;

		sections.push({
			name: "context",
			status:
				isPlaceholder || isMinimal
					? "todo"
					: contextContent.length < 200
						? "partial"
						: "complete",
			hint: "Describe the background, constraints, and current vs desired state",
		});
	}

	// Analyze <tasks> section
	const tasksMatch = content.match(/<tasks>([\s\S]*?)<\/tasks>/);
	if (tasksMatch) {
		const tasksContent = tasksMatch[1].trim();
		// Check for template placeholders (exact matches)
		const hasPlaceholder = TASK_PLACEHOLDERS.some((p) =>
			tasksContent.includes(p),
		);
		const taskCount = (tasksContent.match(/<task/g) || []).length;

		sections.push({
			name: "tasks",
			status: hasPlaceholder ? "todo" : taskCount < 2 ? "partial" : "complete",
			hint: "Define specific tasks with name, files, and action details",
		});
	}

	// Analyze <verification> section
	const verifyMatch = content.match(/<verification>([\s\S]*?)<\/verification>/);
	if (verifyMatch) {
		const verifyContent = verifyMatch[1].trim();
		// Check for exact placeholder
		const hasPlaceholder = verifyContent.includes(VERIFY_PLACEHOLDER);
		const checkCount = (verifyContent.match(/- \[ \]/g) || []).length;

		sections.push({
			name: "verification",
			status:
				hasPlaceholder ? "todo" : checkCount < 3 ? "partial" : "complete",
			hint: "Add specific acceptance criteria and test commands",
		});
	}

	// If explicit TODO block exists, mark incomplete sections as todo
	if (hasTodoMarker) {
		for (const section of sections) {
			if (section.status === "partial") {
				section.status = "todo";
			}
		}
	}

	return sections;
}

/**
 * Parse objective from PLAN.md file
 */
function parseObjective(planPath: string): string {
	try {
		const content = readFileSync(planPath, "utf-8");
		const objMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
		if (objMatch) {
			return objMatch[1]
				.split("\n")
				.map((l) => l.trim())
				.filter(
					(l) => l && !l.startsWith("Purpose:") && !l.startsWith("Output:"),
				)
				.join(" ")
				.trim();
		}
		return "No objective found";
	} catch {
		return "Failed to read plan";
	}
}

/**
 * Get current active phase from tracks
 */
export function getCurrentPhase(): string | null {
	const tracks = listRuns();
	// Find most recently updated active track
	const activeTrack = tracks.find((t) => matchState(t.state, "active"));
	if (activeTrack) {
		// Extract phase from plan_path
		const match = activeTrack.plan_path.match(/(\d+(?:\.\d+)?)-[^/]+\//);
		return match ? match[1] : null;
	}
	return null;
}

/**
 * Find phase directory within a given phasesDir
 * Like getPhaseDir but works with arbitrary base path
 */
function getPhaseDirInPath(phasesDir: string, phaseId: string): string | null {
	if (!existsSync(phasesDir)) {
		return null;
	}
	const dirs = readdirSync(phasesDir);
	return dirs.find((d) => d.startsWith(`${phaseId}-`)) ?? null;
}

/**
 * Get next sequential plan number in a phase (max + 1, ignores gaps)
 *
 * Convention: 01-90 = normal work, 91+ = late phase signals
 * Returns max(1-90) + 1, ignoring 91+ plans
 */
export function getNextPlanNumber(phaseId: string): number {
	const phasesDir = resolvePhasesDir();
	const phaseDir = getPhaseDirInPath(phasesDir, phaseId);

	if (!phaseDir) {
		return 1;
	}

	const fullPath = join(phasesDir, phaseDir);
	return getNextPlanNumberInDir(fullPath, phaseId);
}

/**
 * Get next sequential plan number in a specific directory
 * Used when initiative is resolved and we have the full path
 */
export function getNextPlanNumberInDir(fullPath: string, phaseId: string): number {
	if (!existsSync(fullPath)) {
		return 1;
	}

	const files = readdirSync(fullPath);
	// Match pattern: XX.X-YY-PLAN.md or XX-YY-PLAN.md
	const planPattern = new RegExp(
		`^${phaseId.replace(".", "\\.")}-?(\\d+)-PLAN\\.md$`,
	);

	const numbers = files
		.map((f) => {
			const match = f.match(planPattern);
			return match ? parseInt(match[1], 10) : 0;
		})
		.filter((n) => n > 0 && n <= 90);

	if (numbers.length === 0) {
		return 1;
	}

	return Math.max(...numbers) + 1;
}

interface PlanInfo {
	ref: string;
	path: string;
	title: string;
	type: string;
	track: { id: string; state: string } | null;
}

/**
 * Get all plans in a phase
 */
function getPlansInPhase(phaseId: string): PlanInfo[] {
	const phasesDir = resolvePhasesDir();
	const phaseDir = getPhaseDirInPath(phasesDir, phaseId);

	if (!phaseDir) {
		return [];
	}

	const fullPath = join(phasesDir, phaseDir);
	if (!existsSync(fullPath)) {
		return [];
	}

	const files = readdirSync(fullPath).filter((f) => f.endsWith("-PLAN.md"));
	const tracks = listRuns();
	const plans: PlanInfo[] = [];

	for (const file of files) {
		const planPath = join(fullPath, file);
		const ref = file.replace("-PLAN.md", "");

		// Parse frontmatter for type and title
		let type = "execute";
		let title = "";
		try {
			const content = readFileSync(planPath, "utf-8");
			const typeMatch = content.match(/^type:\s*(\w+)/m);
			if (typeMatch) type = typeMatch[1];
			// Prefer frontmatter title over objective
			const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?/m);
			if (titleMatch) {
				title = titleMatch[1].replace(/^TODO REPHRASE:\s*/i, "");
			}
		} catch {
			// ignore
		}
		// Fall back to objective if no title
		if (!title) {
			title = parseObjective(planPath).slice(0, 60);
		}

		// Find matching track
		const track = tracks.find((t) => t.plan_path === planPath);

		plans.push({
			ref,
			path: planPath,
			title,
			type,
			track: track ? { id: track.id, state: track.state } : null,
		});
	}

	// Sort by ref
	return plans.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * Generate heuristic title from objective
 * Takes first ~40 chars, truncates at word boundary
 */
function generateHeuristicTitle(objective: string): string {
	// Clean up common prefixes
	let cleaned = objective
		.replace(/^(Add|Fix|Implement|Create|Update|Remove)\s+/i, (m) => m)
		.trim();

	// Take first ~40 chars, break at word boundary
	if (cleaned.length <= 40) {
		return cleaned;
	}

	const truncated = cleaned.slice(0, 40);
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > 20) {
		return truncated.slice(0, lastSpace);
	}
	return truncated;
}

/**
 * Generate plan template
 */
function generatePlanTemplate(opts: {
	phase: string;
	plan: number;
	type: string;
	title: string;
	objective: string;
	priority?: number;
}): string {
	const planNum = opts.plan.toString().padStart(2, "0");
	const titleLine = opts.title
		? `title: "${opts.title.replace(/"/g, '\\"')}"\n`
		: "";
	const priorityLine = opts.priority !== undefined
		? `priority: ${opts.priority}\n`
		: "";
	return `---
${titleLine}phase: ${opts.phase}
plan: ${planNum}
type: ${opts.type}
wave: 1
${priorityLine}depends_on: []
files_modified: []
autonomous: true
---

<objective>
${opts.objective}
</objective>

<!-- EXPAND: Run \`tiller plan expand ${opts.phase}-${planNum}\` to fill these sections -->
<context>
Background and constraints.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Description</name>
  <files>files/to/modify</files>
  <action>
What to do.
  </action>
</task>

</tasks>

<verification>
<!-- Backticks = auto-run by tiller verify --auto. No backticks = manual check -->
- [ ] \`tsc --noEmit\` passes
- [ ] \`bun run test\` passes
- [ ] Manual acceptance criteria (describe what to verify)
</verification>
<!-- END EXPAND -->
`;
}

export function registerPlanCommands(program: Command): void {
	const plan = program.command("plan").description("Plan management commands");

	// tiller plan next
	plan
		.command("next")
		.description("Show next sequential plan number (max + 1, ignores gaps)")
		.option("--phase <id>", "Target phase (default: current active)")
		.action((options: { phase?: string }) => {
			const phaseId = options.phase || getCurrentPhase();
			if (!phaseId) {
				console.error("No active phase. Use --phase <id> to specify.");
				process.exit(1);
			}

			const nextNum = getNextPlanNumber(phaseId);
			const paddedNum = nextNum.toString().padStart(2, "0");
			console.log(`${phaseId}-${paddedNum}`);
		});

	// tiller plan create
	plan
		.command("create <objective>")
		.description("Create new plan in current phase")
		.addHelpText("after", `
After creating a plan:
  tiller activate <ref>      Start work on the plan
  tiller plan set <ref> title "..."   Update title
  tiller show <ref>          View plan details
`)
		.option("--phase <id>", "Target phase (default: current active)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--type <type>", "Plan type: execute|research (default: execute)")
		.option("--title <title>", "Set title (default: auto-generated from objective)")
		.option("--priority <n>", "Priority 0-4 (0=critical, 2=medium, 4=backlog)")
		.option("--dry-run", "Show what would be created without writing")
		.action((objective: string, options: { phase?: string; initiative?: string; type?: string; title?: string; priority?: string; dryRun?: boolean }) => {
			// Normalize phase: accept "06.6-tiller-ax-friction" → "06.6"
			const rawPhase = options.phase || getCurrentPhase();
			if (!rawPhase) {
				console.error("No active phase. Use --phase <id> to specify.");
				process.exit(1);
			}
			const phaseMatch = rawPhase.match(/^(\d+(?:\.\d+)?)/);
			const phaseId = phaseMatch ? phaseMatch[1] : rawPhase;

			const config = loadConfig();
			const initiative = resolveInitiative(options.initiative);

			// Block when unfocused: no explicit --initiative AND no explicit working_initiative
			// Note: hasExplicitFocus() checks for user-set focus, ignoring default_initiative fallback
			if (!options.initiative && !hasExplicitFocus()) {
				const available = listInitiatives();
				console.log(`\`\`\`toon
plan_create_error:
  error: "no_initiative_focused"
  available_initiatives:
${available.map(i => `    - ${i}`).join('\n')}
\`\`\`
agent_hint: "No initiative focused. Either run \`tiller focus <name>\` first, or use \`--initiative <name>\` flag for one-off."`);
				process.exit(1);
			}

			// Track if using working_initiative implicitly (for reminder)
			const workingInitiative = getWorkingInitiative();
			const usingWorkingInitiative = !options.initiative && workingInitiative && initiative === workingInitiative;

			// Resolve plans directory based on initiative
			let phasesDir: string;
			if (initiative) {
				phasesDir = join(config.paths.plans, initiative);
			} else {
				phasesDir = config.paths.plans;
			}

			// Track what will be created (for dry-run reporting)
			let willCreateInitiative = false;
			let willCreatePhase = false;

			// Check if initiative directory exists
			if (!existsSync(phasesDir)) {
				willCreateInitiative = true;
				if (!options.dryRun) {
					mkdirSync(phasesDir, { recursive: true });
					console.log(`✓ Created initiative directory: ${phasesDir}`);
				}
			}

			// Find or create phase directory
			const dirs = existsSync(phasesDir) ? readdirSync(phasesDir) : [];
			let phaseDir = dirs.find((d) => d.startsWith(`${phaseId}-`));

			if (!phaseDir) {
				// Auto-vivify: create phase directory with placeholder name
				phaseDir = `${phaseId}-phase`;
				willCreatePhase = true;
				if (!options.dryRun) {
					const phasePath = join(phasesDir, phaseDir);
					mkdirSync(phasePath, { recursive: true });
					console.log(`✓ Created phase directory: ${phaseDir}`);
					console.log(`  Hint: Rename to meaningful name with tiller phase rename ${phaseId} "<name>"`);
				}
			}

			const planNum = getNextPlanNumberInDir(join(phasesDir, phaseDir), phaseId);
			const paddedNum = planNum.toString().padStart(2, "0");
			const planRef = `${phaseId}-${paddedNum}`;
			const planPath = join(phasesDir, phaseDir, `${planRef}-PLAN.md`);

			// Use explicit title or generate heuristic with TODO REPHRASE prefix
			let planTitle: string;
			let titleIsExplicit = false;
			if (options.title) {
				planTitle = options.title;
				titleIsExplicit = true;
			} else {
				const heuristicTitle = generateHeuristicTitle(objective);
				planTitle = `TODO REPHRASE: ${heuristicTitle}`;
			}

			// Parse and validate priority
			let priority: number | undefined;
			if (options.priority !== undefined) {
				priority = parseInt(options.priority, 10);
				if (isNaN(priority) || priority < 0 || priority > 4) {
					console.error(`Invalid priority: ${options.priority}. Must be 0-4.`);
					process.exit(1);
				}
			}

			const template = generatePlanTemplate({
				phase: phaseId,
				plan: planNum,
				type: options.type || "execute",
				title: planTitle,
				objective,
				priority,
			});

			// --dry-run: Show what would be created
			if (options.dryRun) {
				// Remind agent about working_initiative context
				if (usingWorkingInitiative) {
					console.log(`\n⚠ Using working_initiative: ${workingInitiative}`);
					console.log(`  To target a different initiative: --initiative <name>\n`);
				}

				console.log("## Plan Creation Plan\n");
				console.log("Will create:");
				if (willCreateInitiative) {
					console.log(`  Initiative directory: ${phasesDir}`);
				}
				if (willCreatePhase) {
					console.log(`  Phase directory: ${phaseDir}`);
				}
				console.log(`  File: ${planPath}`);
				console.log(`  Ref: ${planRef}`);
				console.log(`  Phase: ${phaseId}`);
				if (initiative) {
					console.log(`  Initiative: ${initiative}`);
				}
				console.log(`  Type: ${options.type || "execute"}`);
				if (priority !== undefined) {
					console.log(`  Priority: ${priority}`);
				}
				console.log(`\nObjective: ${objective}`);
				console.log(`Title: ${planTitle}${titleIsExplicit ? "" : " (auto-generated)"}`);
				console.log("\n--dry-run: No changes made");
				return;
			}

			writeFileSync(planPath, template);

			// Register track in ready state (skip proposed for ad-hoc plans)
			const track = createRun(planPath, objective, "ready");
			if (initiative) {
				track.initiative = initiative;
				saveRun(track);
			}

			// Remind agent about working_initiative context
			if (usingWorkingInitiative) {
				console.log(`⚠ Using working_initiative: ${workingInitiative}`);
				console.log(`  To target a different initiative: --initiative <name>\n`);
			}

			console.log(`Created: ${planPath}`);
			console.log(`Ref: ${planRef}`);
			if (initiative) {
				console.log(`Initiative: ${initiative}`);
			}

			// TOON output
			console.log(`\n\`\`\`toon
plan_create:
  ref: "${planRef}"
  phase: "${phaseId}"
  initiative: "${initiative || ""}"
  objective: "${objective.replace(/"/g, '\\"')}"
  title: "${planTitle.replace(/"/g, '\\"')}"
  title_explicit: ${titleIsExplicit}
  run_id: "${track.id}"
  run_state: "${track.state}"
\`\`\``);

			if (titleIsExplicit) {
				console.log(`\nTitle: "${planTitle}"`);
			} else {
				console.log(`\nTitle auto-generated: "${planTitle}"`);
				console.log(`To rephrase: tiller plan set ${planRef} title "<better title>"`);
			}
		});

	// tiller plan list
	plan
		.command("list")
		.description("List plans in current phase")
		.option("--phase <id>", "Target phase (default: current active)")
		.option("--all", "Show all phases")
		.action((options: { phase?: string; all?: boolean }) => {
			let phases: string[];

			if (options.all) {
				phases = getAllPhases().map((p) => p.id);
			} else {
				const phaseId = options.phase || getCurrentPhase();
				if (!phaseId) {
					console.error("No active phase. Use --phase <id> or --all.");
					process.exit(1);
				}
				phases = [phaseId];
			}

			for (const phaseId of phases) {
				const plans = getPlansInPhase(phaseId);
				const info = getPhaseInfo(phaseId);
				const phaseName = info ? `${phaseId}-${info.name}` : phaseId;

				console.log(`\n${phaseName}:`);
				if (plans.length === 0) {
					console.log("  (no plans)");
					continue;
				}

				for (const p of plans) {
					const status = p.track?.state || "drafted";
					const icon =
						status === "complete" ? "✓" : status === "drafted" ? "○" : "●";
					const truncTitle =
						p.title.length > 45 ? `${p.title.slice(0, 42)}...` : p.title;
					console.log(`  ${icon} ${p.ref} [${status}] ${truncTitle}`);
				}
			}
		});

	// tiller plan show
	plan
		.command("show <ref>")
		.description("Show plan details")
		.option("--pretty", "Human-readable formatted output")
		.action((ref: string, options: { pretty?: boolean }) => {
			// Try to find plan
			const track = resolveRunRef(ref);
			let planPath: string | null = null;

			if (track) {
				planPath = track.plan_path;
			} else {
				// Search for plan file in current initiative
				const phasesDir = resolvePhasesDir();

				// Extract phase from ref
				const phaseMatch = ref.match(/^(\d+(?:\.\d+)?)-/);
				if (phaseMatch) {
					const phaseId = phaseMatch[1];
					const phaseDir = getPhaseDirInPath(phasesDir, phaseId);
					if (phaseDir) {
						const candidatePath = join(phasesDir, phaseDir, `${ref}-PLAN.md`);
						if (existsSync(candidatePath)) {
							planPath = candidatePath;
						}
					}
				}
			}

			if (!planPath || !existsSync(planPath)) {
				console.error(`Plan not found: ${ref}`);
				process.exit(1);
			}

			// Parse plan
			const content = readFileSync(planPath, "utf-8");
			const objective = parseObjective(planPath);

			// Extract frontmatter
			const phaseMatch = content.match(/^phase:\s*(.+)$/m);
			const typeMatch = content.match(/^type:\s*(.+)$/m);
			const waveMatch = content.match(/^wave:\s*(.+)$/m);
			const depsMatch = content.match(/^depends_on:\s*\[([^\]]*)\]/m);
			const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?/m);

			// Build data structure
			const phase = phaseMatch?.[1] || "unknown";
			const type = typeMatch?.[1] || "execute";
			const wave = waveMatch?.[1] || "1";
			const deps = depsMatch?.[1]?.split(",").map((d) => d.trim()).filter(Boolean) || [];
			const title = titleMatch?.[1]?.replace(/^TODO REPHRASE:\s*/i, "") || null;

			const planData: Record<string, unknown> = {
				plan: {
					ref,
					path: planPath,
					phase,
					type,
					wave,
					...(deps.length > 0 ? { depends_on: deps } : {}),
					...(title ? { title } : {}),
					objective,
					...(track ? {
						track: {
							id: track.id,
							state: track.state,
							plan_ref: getRunPlanRef(track),
						},
					} : {}),
				},
			};

			// Pretty output function
			const printPretty = () => {
				console.log(`PLAN: ${ref}`);
				console.log("═".repeat(55));
				console.log(`Path: ${planPath}`);
				console.log(`Phase: ${phase}`);
				console.log(`Type: ${type}`);
				console.log(`Wave: ${wave}`);
				if (deps.length > 0) {
					console.log(`Depends: ${deps.join(", ")}`);
				}
				console.log("");
				console.log("OBJECTIVE");
				console.log("─".repeat(55));
				console.log(objective);

				if (track) {
					console.log("");
					console.log("TRACK");
					console.log("─".repeat(55));
					console.log(`ID: ${track.id}`);
					console.log(`State: ${track.state}`);
					console.log(`Ref: ${getRunPlanRef(track)}`);
				}
			};

			// Truncate objective for hint
			const objSnippet = objective.length > 40 ? objective.slice(0, 37) + "..." : objective;
			const agentHint = `Present as plan summary. Good: "Plan ${ref} (${type}): ${objSnippet}${track ? ` [${track.state}]` : ""}". Bad: Dumping all fields or raw YAML.`;

			outputTOON(planData, {
				pretty: options.pretty,
				prettyFn: printPretty,
				agent_hint: agentHint,
			});
		});

	// tiller plan set
	plan
		.command("set <ref> <key> [value]")
		.description("Set frontmatter field in PLAN.md (title, type, wave, etc.)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.action(
			(
				ref: string,
				key: string,
				value: string | undefined,
				options: { initiative?: string },
			) => {
				// Validate key
				const validKeys = ["title", "type", "wave", "autonomous"];
				if (!validKeys.includes(key)) {
					console.error(`Invalid key: ${key}`);
					console.error(`Valid keys: ${validKeys.join(", ")}`);
					process.exit(1);
				}

				// Find plan file - first try resolving from run, then search current initiative
				let planPath: string | null = null;
				// Use initiative:ref syntax if --initiative flag provided (01-09 fix)
				const resolveRef = options.initiative ? `${options.initiative}:${ref}` : ref;
				const track = resolveRunRef(resolveRef);
				if (track) {
					planPath = track.plan_path;
				} else {
					// Fallback: search in specified or current initiative
					const phasesDir = resolvePhasesDir(options.initiative);
					const phaseMatch = ref.match(/^(\d+(?:\.\d+)?)-/);
					if (!phaseMatch) {
						console.error(`Invalid plan ref: ${ref}`);
						process.exit(1);
					}
					const phaseId = phaseMatch[1];
					const phaseDir = getPhaseDirInPath(phasesDir, phaseId);
					if (phaseDir) {
						const candidatePath = join(phasesDir, phaseDir, `${ref}-PLAN.md`);
						if (existsSync(candidatePath)) {
							planPath = candidatePath;
						}
					}
				}

				if (!planPath || !existsSync(planPath)) {
					console.error(`Plan not found: ${ref}`);
					process.exit(1);
				}

			const content = readFileSync(planPath, "utf-8");

			// If no value provided, return TOON
			if (!value) {
				const objective = parseObjective(planPath);
				const existingMatch = content.match(
					new RegExp(`^${key}:\\s*"?([^"\\n]+)"?$`, "m"),
				);
				console.log(`\`\`\`toon
plan_set:
  ref: "${ref}"
  key: "${key}"
  current: ${existingMatch ? `"${existingMatch[1]}"` : "null"}
  objective: "${objective.replace(/"/g, '\\"')}"
\`\`\`

Task: ${key === "title" ? "Summarize the objective as a short title (3-6 words)" : `Provide a value for ${key}`}.
agent_hint: tiller plan set ${ref} ${key} <value>${options.initiative ? ` --initiative ${options.initiative}` : ""}`);
				return;
			}

			// Format value based on key type
			const formattedValue = key === "title" ? `"${value}"` : value;
			const existingMatch = content.match(new RegExp(`^${key}:\\s*.+$`, "m"));

			let newContent: string;
			if (existingMatch) {
				// Update existing key
				newContent = content.replace(
					new RegExp(`^${key}:\\s*.+$`, "m"),
					`${key}: ${formattedValue}`,
				);
			} else {
				// Add key after opening ---
				newContent = content.replace(
					/^---\n/,
					`---\n${key}: ${formattedValue}\n`,
				);
			}

			writeFileSync(planPath, newContent);
				console.log(`✓ Set ${key}: ${formattedValue}`);
				console.log(`  Path: ${planPath}`);
			},
		);

	// tiller plan expand
	plan
		.command("expand <ref>")
		.description("Analyze plan and output TOON prompting agent to fill TODO sections")
		.action((ref: string) => {
			// Find plan file in current initiative
			const phasesDir = resolvePhasesDir();

			const phaseMatch = ref.match(/^(\d+(?:\.\d+)?)-/);
			if (!phaseMatch) {
				console.error(`Invalid plan ref: ${ref}`);
				process.exit(1);
			}

			const phaseId = phaseMatch[1];
			const phaseDir = getPhaseDirInPath(phasesDir, phaseId);
			if (!phaseDir) {
				console.error(`Phase not found: ${phaseId}`);
				process.exit(1);
			}

			const planPath = join(phasesDir, phaseDir, `${ref}-PLAN.md`);
			if (!existsSync(planPath)) {
				console.error(`Plan not found: ${planPath}`);
				process.exit(1);
			}

			const content = readFileSync(planPath, "utf-8");
			const objective = parseObjective(planPath);
			const sections = analyzePlanSections(content);

			// Check if any sections need work
			const todoSections = sections.filter((s) => s.status !== "complete");
			if (todoSections.length === 0) {
				console.log(`✓ Plan ${ref} is fully expanded`);
				console.log(`  Path: ${planPath}`);
				return;
			}

			// Output TOON
			console.log(`\`\`\`toon
plan_expand:
  ref: "${ref}"
  path: "${planPath}"
  objective: "${objective.replace(/"/g, '\\"')}"
  sections:`);

			for (const section of sections) {
				console.log(`    - name: ${section.name}`);
				console.log(`      status: ${section.status}`);
				console.log(`      hint: "${section.hint}"`);
			}

			console.log(`\`\`\`

Task: Read the plan file and expand sections marked as 'todo' or 'partial'.
agent_hint: Use Edit tool to update ${planPath} with detailed content for incomplete sections. After completing all tasks, run: tiller verify ${ref}`);
		});

	// tiller plan move <ref> --to-phase <id>
	plan
		.command("move <ref>")
		.description("Move plan to different phase (updates file location and frontmatter)")
		.requiredOption("--to-phase <id>", "Target phase ID")
		.option("--initiative <name>", "Target initiative (default: current)")
		.option("--dry-run", "Show what would change without writing")
		.action(
			(
				ref: string,
				options: { toPhase: string; initiative?: string; dryRun?: boolean },
			) => {
				const phasesDir = resolvePhasesDir(options.initiative);

				// Parse source ref
				const srcPhaseMatch = ref.match(/^(\d+(?:\.\d+)?)-(\d+)$/);
				if (!srcPhaseMatch) {
					console.error(`Invalid plan ref: ${ref}. Expected format: XX-YY`);
					process.exit(1);
				}

				const srcPhaseId = srcPhaseMatch[1];
				const srcPlanNum = srcPhaseMatch[2];

				// Find source phase directory
				const srcPhaseDir = getPhaseDirInPath(phasesDir, srcPhaseId);
				if (!srcPhaseDir) {
					console.error(`Source phase not found: ${srcPhaseId}`);
					process.exit(1);
				}

				const srcPath = join(phasesDir, srcPhaseDir, `${ref}-PLAN.md`);
				if (!existsSync(srcPath)) {
					console.error(`Plan not found: ${srcPath}`);
					process.exit(1);
				}

				// Find target phase directory
				const dstPhaseId = options.toPhase.padStart(2, "0");
				const dstPhaseDir = getPhaseDirInPath(phasesDir, dstPhaseId);
				if (!dstPhaseDir) {
					console.error(`Target phase not found: ${dstPhaseId}`);
					process.exit(1);
				}

				// Get next plan number in target phase
				const dstPlanNum = getNextPlanNumberInDir(
					join(phasesDir, dstPhaseDir),
					dstPhaseId,
				);
				const dstPlanNumPadded = dstPlanNum.toString().padStart(2, "0");
				const newRef = `${dstPhaseId}-${dstPlanNumPadded}`;
				const dstPath = join(phasesDir, dstPhaseDir, `${newRef}-PLAN.md`);

				// Read and update content
				let content = readFileSync(srcPath, "utf-8");
				content = content.replace(/^phase:\s*.+$/m, `phase: ${dstPhaseId}`);
				content = content.replace(/^plan:\s*.+$/m, `plan: ${dstPlanNumPadded}`);

				if (options.dryRun) {
					console.log("\n## Plan Move\n");
					console.log(`From: ${srcPath}`);
					console.log(`To:   ${dstPath}`);
					console.log(`\nRef change: ${ref} → ${newRef}`);
					console.log("\n--dry-run: No changes made");
					return;
				}

				// Write to new location and remove old
				writeFileSync(dstPath, content);
				unlinkSync(srcPath);

				console.log(`✓ Moved plan: ${ref} → ${newRef}`);
				console.log(`  From: ${srcPath}`);
				console.log(`  To:   ${dstPath}`);
			},
		);
}
