/**
 * Tiller summary commands - SUMMARY.md query and drift detection
 *
 * Commands:
 * - query     Extract specific sections from SUMMARY.md files
 * - drift     Check SUMMARY.md claims against reality
 * - show      Display formatted SUMMARY.md content
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { Command } from "commander";
import { extractHtmlTag, extractTextWithoutCode } from "../markdown/parser.js";
import { planExists, readPlanFile } from "../state/paths.js";
import {
	findActiveRun,
	listRuns,
	resolveRunRef,
} from "../state/run.js";
import type { Run } from "../types/index.js";
import { matchState } from "../types/index.js";

// Query types supported by summary query
export type SummaryQueryType =
	| "objective"
	| "deliverables"
	| "tasks"
	| "verification"
	| "commits"
	| "notes"
	| "epic_id"
	| "phase"
	| "plan";

const QUERY_TYPES: SummaryQueryType[] = [
	"objective",
	"deliverables",
	"tasks",
	"verification",
	"commits",
	"notes",
	"epic_id",
	"phase",
	"plan",
];

// Helper to extract section content between headers
function extractSection(content: string, sectionName: string): string[] {
	const lines = content.split("\n");
	const results: string[] = [];
	let inSection = false;

	for (const line of lines) {
		// Check for section header
		if (line.match(new RegExp(`^## ${sectionName}`, "i"))) {
			inSection = true;
			continue;
		}
		// Check for next section
		if (inSection && line.match(/^## /)) {
			break;
		}
		if (inSection && line.trim()) {
			results.push(line);
		}
	}

	return results;
}

// Extract frontmatter field
function extractFrontmatter(content: string, field: string): string | null {
	const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : null;
}

// Extract backticked content from lines
function extractBackticked(lines: string[]): string[] {
	const results: string[] = [];
	for (const line of lines) {
		const matches = line.match(/`([^`]+)`/g);
		if (matches) {
			results.push(...matches.map((m) => m.replace(/`/g, "")));
		}
	}
	return results;
}

// Query SUMMARY.md file
export function querySummary(
	filePath: string,
	queryType: SummaryQueryType,
): string[] {
	if (!fs.existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`);
	}

	const content = fs.readFileSync(filePath, "utf-8");

	switch (queryType) {
		case "objective": {
			const lines = extractSection(content, "Objective");
			return lines.slice(0, 5); // First 5 lines
		}

		case "deliverables": {
			const lines = extractSection(content, "Deliverables");
			return extractBackticked(lines);
		}

		case "tasks": {
			const lines = extractSection(content, "Tasks");
			return lines.filter((l) => l.match(/^\d+\./));
		}

		case "verification": {
			const lines = extractSection(content, "Verification");
			return lines.filter((l) => l.match(/^- [✓✗]/));
		}

		case "commits": {
			const lines = extractSection(content, "Commits");
			return extractBackticked(lines);
		}

		case "notes": {
			const lines = extractSection(content, "Notes");
			return lines.filter((l) => l.match(/^- /));
		}

		case "epic_id": {
			const value = extractFrontmatter(content, "epic_id");
			return value ? [value] : [];
		}

		case "phase": {
			const value = extractFrontmatter(content, "phase");
			return value ? [value] : [];
		}

		case "plan": {
			const value = extractFrontmatter(content, "plan");
			return value ? [value] : [];
		}

		default:
			throw new Error(`Unknown query type: ${queryType}`);
	}
}

// Detect if file is a template/schema (should skip drift check)
export function isTemplate(filePath: string, content: string): boolean {
	const basename = filePath.split("/").pop() || "";

	// Check filename for schema/template
	if (/schema|template/i.test(basename)) {
		return true;
	}

	// Check for placeholder patterns
	if (/<filepath>|<placeholder>|\[TBD\]|\[To be added\]/i.test(content)) {
		return true;
	}

	// Check for example commit hashes (abc, def patterns)
	const exampleHashes = content.match(/\b[a-f0-9]{6,7}\b/g)?.slice(0, 3) || [];
	for (const h of exampleHashes) {
		if (/^(abc|def|123|000)/.test(h)) {
			return true;
		}
	}

	return false;
}

// Check if git commit exists
function commitExists(hash: string): boolean {
	try {
		execSync(`git rev-parse ${hash}`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

// Drift check result
export interface DriftResult {
	file: string;
	is_template: boolean;
	deliverables: Array<{ path: string; exists: boolean }>;
	commits: Array<{ hash: string; exists: boolean }>;
	drift: boolean;
}

// Check SUMMARY.md for drift
export function checkDrift(filePath: string, force = false): DriftResult {
	if (!fs.existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`);
	}

	const content = fs.readFileSync(filePath, "utf-8");
	const is_template = isTemplate(filePath, content);

	// Return early if template (unless forced)
	if (is_template && !force) {
		return {
			file: filePath,
			is_template: true,
			deliverables: [],
			commits: [],
			drift: false,
		};
	}

	// Check deliverables
	const deliverablePaths = querySummary(filePath, "deliverables");
	const deliverables = deliverablePaths.map((path) => ({
		path,
		exists: fs.existsSync(path),
	}));

	// Check commits
	const commitHashes = querySummary(filePath, "commits");
	const commits = commitHashes.map((hash) => ({
		hash,
		exists: commitExists(hash),
	}));

	// Determine if drift exists
	const drift =
		deliverables.some((d) => !d.exists) || commits.some((c) => !c.exists);

	return {
		file: filePath,
		is_template,
		deliverables,
		commits,
		drift,
	};
}

// Get summary file path from active track
function getSummaryFromTrack(): string | null {
	const tracks = listRuns();
	const active = tracks.find((t) => matchState(t.state, "active"));

	if (!active) {
		return null;
	}

	// Derive summary path from plan path
	return active.plan_path.replace(/-PLAN\.md$/, "-SUMMARY.md");
}

export function registerSummaryCommands(program: Command): void {
	const summary = program
		.command("summary")
		.description("Query and verify SUMMARY.md files");

	// ============================================
	// query: Extract sections from SUMMARY.md
	// ============================================
	summary
		.command("query [file] <type>")
		.description("Extract specific sections from SUMMARY.md")
		.option("--json", "Output as JSON array")
		.addHelpText(
			"after",
			`
Query types:
  objective     Extract objective paragraph
  deliverables  List deliverable filepaths
  tasks         List tasks with outcomes
  verification  List verification results
  commits       List commit hashes
  notes         List notes
  epic_id       Extract epic_id from frontmatter
  phase         Extract phase from frontmatter
  plan          Extract plan number from frontmatter

Examples:
  tiller summary query ./SUMMARY.md tasks
  tiller summary query tasks              # Uses active track's summary
  tiller summary query ./SUMMARY.md deliverables --json
`,
		)
		.action(
			(
				fileOrType: string,
				typeArg: string | undefined,
				options: { json?: boolean },
			) => {
				// Handle both "query <file> <type>" and "query <type>" (track-based)
				let filePath: string;
				let queryType: SummaryQueryType;

				if (typeArg && QUERY_TYPES.includes(typeArg as SummaryQueryType)) {
					// query <file> <type>
					filePath = fileOrType;
					queryType = typeArg as SummaryQueryType;
				} else if (QUERY_TYPES.includes(fileOrType as SummaryQueryType)) {
					// query <type> - use track
					const trackSummary = getSummaryFromTrack();
					if (!trackSummary) {
						console.error("No active run. Specify a file path.");
						console.error("Usage: tiller summary query <file> <type>");
						process.exit(2);
					}
					filePath = trackSummary;
					queryType = fileOrType as SummaryQueryType;
				} else {
					console.error(`Invalid query type: ${typeArg || fileOrType}`);
					console.error(`Valid types: ${QUERY_TYPES.join(", ")}`);
					process.exit(1);
				}

				try {
					const results = querySummary(filePath, queryType);

					if (options.json) {
						console.log(JSON.stringify(results, null, 2));
					} else {
						for (const line of results) {
							console.log(line);
						}
					}
				} catch (err) {
					console.error((err as Error).message);
					process.exit(2);
				}
			},
		);

	// ============================================
	// drift: Check SUMMARY.md against reality
	// ============================================
	summary
		.command("drift [file]")
		.description("Check SUMMARY.md claims against reality")
		.option("--force", "Check even if file appears to be a template/schema")
		.option("--json", "Output as JSON")
		.action(
			(
				file: string | undefined,
				options: { force?: boolean; json?: boolean },
			) => {
				// Use track summary if no file provided
				let filePath = file;
				if (!filePath) {
					const trackSummary = getSummaryFromTrack();
					if (!trackSummary) {
						console.error("No active run. Specify a file path.");
						console.error("Usage: tiller summary drift <file>");
						process.exit(2);
					}
					filePath = trackSummary;
				}

				try {
					const result = checkDrift(filePath, options.force);

					if (options.json) {
						console.log(JSON.stringify(result, null, 2));
						process.exit(result.drift ? 1 : 0);
					}

					// Template warning
					if (result.is_template && !options.force) {
						console.log(
							"Warning: File appears to be a schema/template (contains example placeholders)",
						);
						console.log(`File: ${filePath}`);
						console.log("");
						console.log("Use --force to check anyway:");
						console.log(`  tiller summary drift --force ${filePath}`);
						process.exit(0);
					}

					// Human-readable output
					if (options.force) {
						console.log(`Checking SUMMARY.md: ${filePath} (forced)`);
					} else {
						console.log(`Checking SUMMARY.md: ${filePath}`);
					}
					console.log("═".repeat(59));

					// Deliverables
					console.log("");
					console.log("Checking deliverables exist...");
					if (result.deliverables.length === 0) {
						console.log("  (no deliverables found in SUMMARY)");
					} else {
						for (const d of result.deliverables) {
							const icon = d.exists ? "✓" : "✗";
							const suffix = d.exists ? "" : " (MISSING)";
							console.log(`  ${icon} ${d.path}${suffix}`);
						}
					}

					// Commits
					console.log("");
					console.log("Checking commits exist...");
					if (result.commits.length === 0) {
						console.log("  (no commits found in SUMMARY)");
					} else {
						for (const c of result.commits) {
							const icon = c.exists ? "✓" : "✗";
							const suffix = c.exists ? "" : " (NOT FOUND in git)";
							console.log(`  ${icon} ${c.hash}${suffix}`);
						}
					}

					// Summary
					console.log("");
					console.log("─".repeat(59));
					if (result.drift) {
						console.log("✗ DRIFT DETECTED - SUMMARY.md does not match reality");
						process.exit(1);
					} else {
						console.log("✓ No drift detected");
						process.exit(0);
					}
				} catch (err) {
					console.error((err as Error).message);
					process.exit(2);
				}
			},
		);

	// ============================================
	// show: Display formatted SUMMARY.md content
	// ============================================
	summary
		.command("show [file]")
		.description("Display formatted SUMMARY.md content")
		.option("--json", "Output as JSON")
		.action((file: string | undefined, options: { json?: boolean }) => {
			// Use track summary if no file provided
			let filePath = file;
			if (!filePath) {
				const trackSummary = getSummaryFromTrack();
				if (!trackSummary) {
					console.error("No active run. Specify a file path.");
					console.error("Usage: tiller summary show <file>");
					process.exit(2);
				}
				filePath = trackSummary;
			}

			if (!fs.existsSync(filePath)) {
				console.error(`File not found: ${filePath}`);
				process.exit(2);
			}

			const content = fs.readFileSync(filePath, "utf-8");

			// Parse all sections
			const parsed = {
				file: filePath,
				frontmatter: {
					epic_id: extractFrontmatter(content, "epic_id"),
					phase: extractFrontmatter(content, "phase"),
					plan: extractFrontmatter(content, "plan"),
					completed: extractFrontmatter(content, "completed"),
					baseline_commit: extractFrontmatter(content, "baseline_commit"),
					tasks_completed: extractFrontmatter(content, "tasks_completed"),
				},
				objective: extractSection(content, "Objective").slice(0, 5).join(" "),
				deliverables: extractBackticked(
					extractSection(content, "Deliverables"),
				),
				tasks: extractSection(content, "Tasks").filter((l) =>
					l.match(/^\d+\./),
				),
				verification: extractSection(content, "Verification").filter((l) =>
					l.match(/^- [✓✗]/),
				),
				commits: extractBackticked(extractSection(content, "Commits")),
				notes: extractSection(content, "Notes").filter((l) => l.match(/^- /)),
			};

			if (options.json) {
				console.log(JSON.stringify(parsed, null, 2));
				return;
			}

			// Human-readable formatted output
			const title = content.match(/^# (.+)$/m)?.[1] || `Summary: ${filePath}`;
			console.log(title);
			console.log("═".repeat(59));

			// Frontmatter info
			if (parsed.frontmatter.epic_id) {
				console.log(`Epic: ${parsed.frontmatter.epic_id}`);
			}
			if (parsed.frontmatter.phase) {
				console.log(`Phase: ${parsed.frontmatter.phase}`);
			}
			if (parsed.frontmatter.plan) {
				console.log(`Plan: ${parsed.frontmatter.plan}`);
			}
			if (parsed.frontmatter.completed) {
				console.log(`Completed: ${parsed.frontmatter.completed}`);
			}
			if (parsed.frontmatter.tasks_completed) {
				console.log(`Progress: ${parsed.frontmatter.tasks_completed}`);
			}

			// Objective
			if (parsed.objective) {
				console.log("");
				console.log("OBJECTIVE");
				console.log("─".repeat(55));
				console.log(parsed.objective);
			}

			// Tasks with progress
			if (parsed.tasks.length > 0) {
				console.log("");
				console.log("TASKS");
				console.log("─".repeat(55));

				let completed = 0;
				for (const task of parsed.tasks) {
					// Check for completion markers
					const isComplete = /✓|closed|done/i.test(task);
					if (isComplete) completed++;

					const icon = isComplete ? "✓" : "○";
					// Clean up task text for display
					const cleanTask = task.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "");
					console.log(`  ${icon} ${cleanTask}`);
				}

				// Progress bar
				const total = parsed.tasks.length;
				const pct = Math.round((completed / total) * 100);
				const barWidth = 20;
				const filled = Math.round((pct / 100) * barWidth);
				const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
				console.log("");
				console.log(`  Progress: ${bar} ${pct}% (${completed}/${total})`);
			}

			// Deliverables
			if (parsed.deliverables.length > 0) {
				console.log("");
				console.log("DELIVERABLES");
				console.log("─".repeat(55));
				for (const d of parsed.deliverables) {
					const exists = fs.existsSync(d);
					const icon = exists ? "✓" : "✗";
					console.log(`  ${icon} ${d}`);
				}
			}

			// Verification
			if (parsed.verification.length > 0) {
				console.log("");
				console.log("VERIFICATION");
				console.log("─".repeat(55));
				for (const v of parsed.verification) {
					console.log(`  ${v.replace(/^- /, "")}`);
				}
			}

			// Commits
			if (parsed.commits.length > 0) {
				console.log("");
				console.log("COMMITS");
				console.log("─".repeat(55));
				for (const c of parsed.commits) {
					console.log(`  ${c}`);
				}
			}

			// Notes
			if (parsed.notes.length > 0) {
				console.log("");
				console.log("NOTES");
				console.log("─".repeat(55));
				for (const n of parsed.notes) {
					console.log(`  ${n.replace(/^- /, "• ")}`);
				}
			}
		});

	// ============================================
	// generate: Auto-generate SUMMARY.md from track
	// ============================================
	summary
		.command("generate [ref]")
		.description(
			"Auto-generate SUMMARY.md from run (accepts plan ref like 06.6-07)",
		)
		.option("--dry-run", "Preview without writing")
		.option("--force", "Overwrite existing SUMMARY.md")
		.option("--json", "Output as JSON instead of markdown")
		.action(
			(
				ref: string | undefined,
				options: { dryRun?: boolean; force?: boolean; json?: boolean },
			) => {
				// Get run (accepts plan ref like 06.6-07 or run ID)
				let run: Run | null = null;
				if (ref) {
					run = resolveRunRef(ref);
					if (!run) {
						console.error(`Run not found: ${ref}`);
						process.exit(2);
					}
				} else {
					run = findActiveRun();
					if (!run) {
						console.error("No active run. Specify a ref.");
						console.error("Usage: tiller summary generate <ref>");
						process.exit(2);
					}
				}

				// Derive summary path from plan path
				const summaryPath = run.plan_path.replace(
					/-PLAN\.md$/,
					"-SUMMARY.md",
				);

				// Check if exists (unless --force)
				if (fs.existsSync(summaryPath) && !options.force && !options.dryRun) {
					console.error(`SUMMARY.md already exists: ${summaryPath}`);
					console.error("Use --force to overwrite or --dry-run to preview.");
					process.exit(1);
				}

				// Read PLAN.md for objective and frontmatter
				let planContent = "";
				let planObjective = "";
				let planPhase = "";
				let planNumber = "";
				let filesModified: string[] = [];

				if (planExists(run.plan_path)) {
					planContent = readPlanFile(run.plan_path);
					planPhase = extractFrontmatter(planContent, "phase") || "";
					planNumber = extractFrontmatter(planContent, "plan") || "";

					// Extract objective from <objective> tags or ## Objective
					const objMatch = planContent.match(
						/<objective>([\s\S]*?)<\/objective>/,
					);
					if (objMatch) {
						planObjective = objMatch[1]
							.split("\n")
							.map((l) => l.trim())
							.filter(
								(l) =>
									l && !l.startsWith("Purpose:") && !l.startsWith("Output:"),
							)
							.join(" ")
							.trim();
					}

					// Extract files_modified from frontmatter
					const filesMatch = planContent.match(/^files_modified:\s*\[(.*?)\]/m);
					if (filesMatch) {
						filesModified = filesMatch[1]
							.split(",")
							.map((f) => f.trim())
							.filter((f) => f);
					}
				}

				// Get commits since track creation
				let commits: Array<{ hash: string; message: string }> = [];
				try {
					// Find baseline commit from track creation or first transition
					const baselineTime = run.created;
					const since = new Date(baselineTime).toISOString().split("T")[0];

					const gitLog = execSync(
						`git log --oneline --since="${since}" --format="%h %s" -- ${filesModified.join(" ") || "."}`,
						{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
					).trim();

					if (gitLog) {
						commits = gitLog.split("\n").map((line) => {
							const [hash, ...rest] = line.split(" ");
							return { hash, message: rest.join(" ") };
						});
					}
				} catch {
					// Git errors are non-fatal
				}

				// Build tasks from beads snapshot
				const tasks: Array<{ title: string; status: string }> = [];
				if (run.beads_snapshot) {
					for (const t of run.beads_snapshot.tasks) {
						tasks.push({
							title: t.title,
							status: t.status === "closed" ? "✓ closed" : t.status,
						});
					}
				}

				// Fallback: extract tasks from PLAN.md <tasks> section (AST-safe per ADR-0002)
				if (tasks.length === 0 && planContent) {
					const tasksSection = extractHtmlTag(planContent, "tasks");
					if (tasksSection) {
						// Recursive AST: strip code blocks from tasks section before regex
						const cleanTasksContent = extractTextWithoutCode(tasksSection);
						const taskMatches = cleanTasksContent.matchAll(
							/<name>([^<]+)<\/name>/gi,
						);
						for (const match of taskMatches) {
							tasks.push({
								title: match[1].trim(),
								status: "✓ done", // Assume done since we're generating SUMMARY at completion
							});
						}
					}
				}

				// Build verification from track
				const verification: Array<{ name: string; status: string }> = [];
				if (run.verification?.automated) {
					for (const c of run.verification.automated.checks) {
						verification.push({
							name: c.name,
							status: c.status === "pass" ? "✓" : "✗",
						});
					}
				}
				if (run.verification?.uat) {
					for (const c of run.verification.uat.checks) {
						verification.push({
							name: c.name,
							status: c.status === "pass" ? "✓" : "✗",
						});
					}
				}

				// Extract title from PLAN frontmatter
				const planTitle =
					extractFrontmatter(planContent, "title")?.replace(/^"|"$/g, "") ||
					null;

				// If no title, error with suggestion
				if (!planTitle) {
					const planRef = `${planPhase}-${planNumber}`;
					console.error(
						`PLAN.md missing title in frontmatter: ${run.plan_path}`,
					);
					console.error(
						`\nAdd title first: tiller plan set ${planRef} title "Your title"`,
					);
					process.exit(1);
				}

				// Build summary data structure
				const summaryData = {
					frontmatter: {
						epic_id: run.beads_epic_id,
						phase: planPhase,
						plan: planNumber,
						completed: new Date().toISOString().split("T")[0],
						tasks_completed: `${tasks.filter((t) => /closed|done/i.test(t.status)).length}/${tasks.length}`,
					},
					title: planTitle || `Phase ${planPhase} Plan ${planNumber}: Summary`,
					objective: planObjective,
					deliverables: filesModified,
					tasks,
					verification,
					commits,
					notes: [] as string[],
				};

				// JSON output
				if (options.json) {
					console.log(JSON.stringify(summaryData, null, 2));
					return;
				}

				// Generate markdown content
				const md = generateSummaryMarkdown(summaryData);

				// Dry run - just print
				if (options.dryRun) {
					console.log("=== DRY RUN - Would write to:", summaryPath, "===\n");
					console.log(md);
					return;
				}

				// Write file
				fs.writeFileSync(summaryPath, md);
				console.log(`✓ Generated: ${summaryPath}`);
			},
		);

	// ============================================
	// scaffold: Create minimal SUMMARY.md template (08-03-PLAN)
	// ============================================
	summary
		.command("scaffold <ref>")
		.description("Create minimal SUMMARY.md template from PLAN.md")
		.option("--force", "Overwrite existing SUMMARY.md")
		.option("--dry-run", "Preview without writing")
		.action(
			(
				ref: string,
				options: { force?: boolean; dryRun?: boolean },
			) => {
				// Resolve run
				const run = resolveRunRef(ref);
				if (!run) {
					console.error(`Run not found: ${ref}`);
					console.error(
						`Hint: Use plan ref (e.g., '06.6-01') or run ID (e.g., 'run-abc123')`,
					);
					process.exit(2);
				}

				// Read PLAN.md
				if (!planExists(run.plan_path)) {
					console.error(`PLAN.md not found: ${run.plan_path}`);
					process.exit(1);
				}

				const planContent = readPlanFile(run.plan_path);

				// Extract frontmatter title and objective
				const titleMatch = planContent.match(/^title:\s*["']?([^"'\n]+)["']?$/m);
				const title = titleMatch
					? titleMatch[1].trim()
					: `Plan ${ref} Summary`;

				const objectiveSection = extractHtmlTag(planContent, "objective");
				const objective = objectiveSection
					? objectiveSection
							.split("\n")
							.map((l) => l.trim())
							.filter((l) => l && !l.startsWith("Purpose:") && !l.startsWith("Output:"))
							.join(" ")
							.trim()
							.slice(0, 200)
					: "";

				// Derive summary path
				const summaryPath = run.plan_path.replace(
					/-PLAN\.md$/,
					"-SUMMARY.md",
				);

				// Check if exists
				if (fs.existsSync(summaryPath) && !options.force && !options.dryRun) {
					console.error(`SUMMARY.md already exists: ${summaryPath}`);
					console.error("Use --force to overwrite.");
					process.exit(1);
				}

				// Note: ref is used directly in the template, we don't need to extract phase/plan

				// Generate minimal template
				const today = new Date().toISOString().split("T")[0];
				const template = `---
title: "${title.replace(/"/g, '\\"')}"
plan: ${ref}
completed: ${today}
---

# ${ref}: ${title} - Summary

## Objective
${objective || "<!-- Objective from PLAN.md -->"}

## Changes
<!-- List files modified and what changed -->

## Verification
<!-- Verification results from tiller verify -->
`;

				if (options.dryRun) {
					console.log("=== DRY RUN - Would write to:", summaryPath, "===\n");
					console.log(template);
					return;
				}

				fs.writeFileSync(summaryPath, template);
				console.log(`✓ Scaffolded: ${summaryPath}`);
				console.log(`\nNext: Edit SUMMARY.md with your changes, then:`);
				console.log(`  tiller verify ${ref} --pass`);
				console.log(`  tiller complete ${ref}`);
			},
		);
}

// Helper to generate SUMMARY.md markdown
function generateSummaryMarkdown(data: {
	frontmatter: {
		epic_id: string | null;
		phase: string;
		plan: string;
		completed: string;
		tasks_completed: string;
	};
	title: string;
	objective: string;
	deliverables: string[];
	tasks: Array<{ title: string; status: string }>;
	verification: Array<{ name: string; status: string }>;
	commits: Array<{ hash: string; message: string }>;
	notes: string[];
}): string {
	const lines: string[] = [];

	// Frontmatter
	lines.push("---");
	lines.push(`title: "${data.title.replace(/"/g, '\\"')}"`);
	if (data.frontmatter.epic_id) {
		lines.push(`epic_id: ${data.frontmatter.epic_id}`);
	}
	lines.push(`phase: ${data.frontmatter.phase}`);
	lines.push(`plan: ${data.frontmatter.plan}`);
	lines.push(`completed: ${data.frontmatter.completed}`);
	lines.push(`tasks_completed: ${data.frontmatter.tasks_completed}`);
	lines.push("---");
	lines.push("");

	// Title
	lines.push(`# ${data.title}`);
	lines.push("");

	// Objective
	if (data.objective) {
		lines.push("## Objective");
		lines.push("");
		lines.push(data.objective);
		lines.push("");
	}

	// Deliverables
	if (data.deliverables.length > 0) {
		lines.push("## Deliverables");
		lines.push("");
		for (const d of data.deliverables) {
			lines.push(`- \`${d}\``);
		}
		lines.push("");
	}

	// Tasks
	if (data.tasks.length > 0) {
		lines.push("## Tasks");
		lines.push("");
		data.tasks.forEach((t, i) => {
			lines.push(`${i + 1}. ${t.title} - ${t.status}`);
		});
		lines.push("");
	}

	// Verification
	if (data.verification.length > 0) {
		lines.push("## Verification");
		lines.push("");
		for (const v of data.verification) {
			lines.push(`- ${v.status} ${v.name}`);
		}
		lines.push("");
	}

	// Commits
	if (data.commits.length > 0) {
		lines.push("## Commits");
		lines.push("");
		for (const c of data.commits) {
			lines.push(`- \`${c.hash}\` ${c.message}`);
		}
		lines.push("");
	}

	// Notes
	if (data.notes.length > 0) {
		lines.push("## Notes");
		lines.push("");
		for (const n of data.notes) {
			lines.push(`- ${n}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}
