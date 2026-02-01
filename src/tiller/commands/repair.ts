/**
 * Tiller repair command - Fix structural issues in planning artifacts
 *
 * Design rationale from 06.6-15:
 * - Clear intent: "something is broken, fix it"
 * - Discoverable: `tiller repair --help` shows all fixups
 * - Separate from `doctor` (diagnosis) vs `repair` (action)
 * - Composable: individual commands or `--all`
 *
 * Commands:
 * - repair all          Run all repair subcommands
 * - repair numbering    Detect/fix phase number collisions
 * - repair tracks       Fix orphaned tracks, broken paths
 * - repair summaries    Regenerate missing/malformed SUMMARY.md
 * - repair frontmatter  Add missing required fields
 *
 * Note: Phase reorganization (insert-before, renumber, absorb-decimals)
 * is handled by `tiller phase` command group, not repair.
 *
 * Note: Parent command has NO action handler (pure namespace).
 * This is required for subcommand options to work correctly.
 * See: Commander.js issue #1307
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { PATHS } from "../state/config.js";
import { normalizePlanPath, planExists } from "../state/paths.js";
import { deleteRun, listRuns, saveRun } from "../state/run.js";

// ============================================================================
// Types
// ============================================================================

interface RepairResult {
	subcommand: string;
	checked: number;
	fixed: number;
	issues: RepairIssue[];
	ok: boolean;
}

interface RepairIssue {
	type: string;
	message: string;
	path?: string;
	fixed: boolean;
	action?: string;
}

interface NumberingCollision {
	phaseNum: string;
	directories: string[];
}

// ============================================================================
// Numbering repair - Detect/fix phase number collisions
// ============================================================================

function detectNumberingCollisions(): NumberingCollision[] {
	const phasesDir = ".planning/phases";
	if (!existsSync(phasesDir)) return [];

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	// Group by phase number prefix (e.g., "07" from "07-toon-first-output")
	const byNumber = new Map<string, string[]>();

	for (const dir of dirs) {
		// Extract leading number: "07", "06.6", etc.
		const match = dir.match(/^(\d+(?:\.\d+)?)/);
		if (!match) continue;

		const phaseNum = match[1];
		if (!byNumber.has(phaseNum)) {
			byNumber.set(phaseNum, []);
		}
		byNumber.get(phaseNum)?.push(dir);
	}

	// Find collisions (multiple dirs with same number)
	const collisions: NumberingCollision[] = [];
	for (const [phaseNum, directories] of byNumber) {
		if (directories.length > 1) {
			collisions.push({ phaseNum, directories });
		}
	}

	return collisions;
}

function detectPlanNumberCollisions(): RepairIssue[] {
	const issues: RepairIssue[] = [];
	const phasesDir = ".planning/phases";
	if (!existsSync(phasesDir)) return [];

	// Track plan refs (e.g., "07-01") across all directories
	const planRefs = new Map<string, string[]>(); // ref -> [paths]

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const dir of dirs) {
		const phaseDir = join(phasesDir, dir);
		const files = readdirSync(phaseDir).filter((f) => f.endsWith("-PLAN.md"));

		for (const file of files) {
			// Extract ref from filename: "07-01-PLAN.md" -> "07-01"
			const ref = file.replace(/-PLAN\.md$/, "");
			const fullPath = join(phaseDir, file);

			if (!planRefs.has(ref)) {
				planRefs.set(ref, []);
			}
			planRefs.get(ref)?.push(fullPath);
		}
	}

	// Find duplicates
	for (const [ref, paths] of planRefs) {
		if (paths.length > 1) {
			issues.push({
				type: "plan-collision",
				message: `Plan ref "${ref}" exists in ${paths.length} locations`,
				path: paths.join(", "),
				fixed: false,
			});
		}
	}

	return issues;
}

function repairNumbering(_dryRun: boolean): RepairResult {
	const issues: RepairIssue[] = [];

	// Check phase directory collisions
	const phaseCollisions = detectNumberingCollisions();
	for (const collision of phaseCollisions) {
		issues.push({
			type: "phase-collision",
			message: `Phase number "${collision.phaseNum}" has ${collision.directories.length} directories: ${collision.directories.join(", ")}`,
			fixed: false,
			action:
				"Manual renumbering required - choose which directory keeps the number",
		});
	}

	// Check plan number collisions within all phases
	const planCollisions = detectPlanNumberCollisions();
	issues.push(...planCollisions);

	return {
		subcommand: "numbering",
		checked: issues.length > 0 ? issues.length : 1,
		fixed: 0, // Numbering requires manual intervention
		issues,
		ok: issues.length === 0,
	};
}

// ============================================================================
// Tracks repair - Fix orphaned tracks and broken paths
// ============================================================================

interface RepairTracksOptions {
	dryRun: boolean;
	deleteOrphans: boolean;
	dedupe: boolean;
	backfillInitiative: boolean;
	verbose: boolean;
}

function repairTracks(options: RepairTracksOptions): RepairResult {
	const { dryRun, deleteOrphans, dedupe, backfillInitiative, verbose } = options;
	const issues: RepairIssue[] = [];
	let fixed = 0;

	const tracks = listRuns();

	if (verbose) {
		console.log(`Found ${tracks.length} run(s) to check`);
	}

	// Dedupe: Find runs with same plan_path, keep the best one
	if (dedupe) {
		const byPlanPath = new Map<string, typeof tracks>();
		for (const track of tracks) {
			const normalizedPath = normalizePlanPath(track.plan_path);
			if (!byPlanPath.has(normalizedPath)) {
				byPlanPath.set(normalizedPath, []);
			}
			byPlanPath.get(normalizedPath)!.push(track);
		}

		for (const [planPath, duplicates] of byPlanPath) {
			if (duplicates.length <= 1) continue;

			// Sort to find "best" run: prefer initiative set, active state, most recent
			const stateScore = (s: string) => {
				if (s.startsWith("active")) return 0;
				if (s.startsWith("verifying")) return 1;
				if (s === "complete") return 2;
				if (s === "ready") return 3;
				return 4;
			};
			duplicates.sort((a, b) => {
				// Prefer has initiative
				if (a.initiative && !b.initiative) return -1;
				if (!a.initiative && b.initiative) return 1;
				// Then by state
				const aScore = stateScore(a.state);
				const bScore = stateScore(b.state);
				if (aScore !== bScore) return aScore - bScore;
				// Then by updated date
				return new Date(b.updated).getTime() - new Date(a.updated).getTime();
			});

			const keep = duplicates[0];
			const toDelete = duplicates.slice(1);

			for (const dup of toDelete) {
				const issue: RepairIssue = {
					type: "duplicate-run",
					message: `Run ${dup.id} duplicates ${keep.id} for ${planPath}`,
					path: planPath,
					fixed: false,
					action: `Delete ${dup.id}, keep ${keep.id} (${keep.state}, initiative: ${keep.initiative ?? "null"})`,
				};

				if (!dryRun) {
					deleteRun(dup.id);
					issue.fixed = true;
					fixed++;
				}

				issues.push(issue);
			}
		}
	}

	// Backfill initiative from plan_path
	if (backfillInitiative) {
		// Re-fetch tracks after potential dedupe deletions
		const currentTracks = listRuns();
		for (const track of currentTracks) {
			if (track.initiative) continue; // Already has initiative

			// Extract initiative from plan_path: plans/<initiative>/... (relative or absolute)
			const match = track.plan_path.match(/(?:^|\/)?plans\/([^/]+)\//);
			if (match) {
				const inferred = match[1];
				const issue: RepairIssue = {
					type: "missing-initiative",
					message: `Run ${track.id} has no initiative`,
					path: track.plan_path,
					fixed: false,
					action: `Set initiative to: ${inferred}`,
				};

				if (!dryRun) {
					track.initiative = inferred;
					track.updated = new Date().toISOString();
					saveRun(track);
					issue.fixed = true;
					fixed++;
				}

				issues.push(issue);
			}
		}
	}

	// Sync state from SUMMARY files (fix state drift)
	// Re-fetch tracks after potential dedupe/backfill changes
	const tracksAfterFixes = listRuns();
	for (const track of tracksAfterFixes) {
		const planDir = track.plan_path.replace(/-PLAN\.md$/, "");
		const summaryDone = `${planDir}-SUMMARY.done.md`;
		const summaryAutopass = `${planDir}-SUMMARY.autopass.md`;

		// Check for .done.md → should be complete
		if (existsSync(summaryDone) && track.state !== "complete") {
			const issue: RepairIssue = {
				type: "state-drift",
				message: `Run ${track.id} has SUMMARY.done.md but state is ${track.state}`,
				path: summaryDone,
				fixed: false,
				action: `Set state to: complete`,
			};

			if (!dryRun) {
				track.state = "complete";
				track.updated = new Date().toISOString();
				saveRun(track);
				issue.fixed = true;
				fixed++;
			}

			issues.push(issue);
		}

		// Check for .autopass.md → should be verifying/passed or complete
		if (
			existsSync(summaryAutopass) &&
			!track.state.startsWith("verifying") &&
			track.state !== "complete"
		) {
			const issue: RepairIssue = {
				type: "state-drift",
				message: `Run ${track.id} has SUMMARY.autopass.md but state is ${track.state}`,
				path: summaryAutopass,
				fixed: false,
				action: `Set state to: verifying/passed`,
			};

			if (!dryRun) {
				track.state = "verifying/passed";
				track.updated = new Date().toISOString();
				saveRun(track);
				issue.fixed = true;
				fixed++;
			}

			issues.push(issue);
		}
	}

	// Skip terminal states (abandoned, complete) - no point fixing paths for dead tracks
	const activeStates = ["proposed", "approved", "ready", "active", "verifying"];
	const relevantTracks = tracks.filter((t) =>
		activeStates.some((s) => t.state.startsWith(s)),
	);

	if (verbose) {
		const skippedCount = tracks.length - relevantTracks.length;
		if (skippedCount > 0) {
			console.log(`Skipping ${skippedCount} run(s) in terminal states (abandoned, complete)`);
		}
	}

	for (const track of relevantTracks) {
		if (verbose) {
			console.log(`Checking ${track.id} (${track.state})...`);
		}
		// Check if plan_path exists
		if (track.plan_path && !planExists(track.plan_path)) {
			if (verbose) {
				console.log(`  ✗ orphaned - plan not found: ${track.plan_path}`);
			}
			const issue: RepairIssue = {
				type: "orphaned-run",
				message: `Run ${track.id} references missing plan: ${track.plan_path}`,
				path: track.plan_path,
				fixed: false,
			};

			// Try to find the plan if it was moved
			const planBasename = basename(track.plan_path);
			const possibleLocations = findPlanByName(planBasename);

			if (possibleLocations.length === 1) {
				issue.action = `Found at ${possibleLocations[0]}`;
				if (!dryRun) {
					track.plan_path = possibleLocations[0];
					track.updated = new Date().toISOString();
					saveRun(track);
					issue.fixed = true;
					fixed++;
				}
			} else if (possibleLocations.length > 1) {
				issue.action = `Multiple matches: ${possibleLocations.join(", ")}`;
			} else {
				// Plan not found anywhere - can delete if --delete-orphans
				if (deleteOrphans) {
					issue.action = "Deleting orphaned run";
					if (!dryRun) {
						deleteRun(track.id);
						issue.fixed = true;
						fixed++;
					}
				} else {
					issue.action =
						"Plan not found - use --delete-orphans to remove";
				}
			}

			issues.push(issue);
		} else if (verbose) {
			console.log(`  ✓ ok`);
		}

		// Check for tracks without plan_path (shouldn't happen but catch it)
		if (!track.plan_path) {
			if (verbose) {
				console.log(`  ✗ invalid - no plan_path`);
			}
			issues.push({
				type: "invalid-track",
				message: `Run ${track.id} has no plan_path`,
				fixed: false,
				action: "Delete orphaned track or set plan_path manually",
			});
		}
	}

	// Check for run files that can't be loaded
	const runsDir = PATHS.RUNS_DIR;
	if (existsSync(runsDir)) {
		const runFiles = readdirSync(runsDir).filter((f) =>
			f.endsWith(".json"),
		);
		for (const file of runFiles) {
			const runPath = join(runsDir, file);
			try {
				JSON.parse(readFileSync(runPath, "utf-8"));
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				// Distinguish between file system errors and JSON parse errors
				if (err.code === "ENOENT") {
					// File disappeared between readdir and read - skip
				} else if (err.code === "EACCES" || err.code === "EPERM") {
					issues.push({
						type: "corrupt-track",
						message: `Run file ${file} cannot be read (permission denied)`,
						path: runPath,
						fixed: false,
						action: "Check file permissions",
					});
				} else if (err instanceof SyntaxError) {
					issues.push({
						type: "corrupt-track",
						message: `Run file ${file} is corrupt (invalid JSON)`,
						path: runPath,
						fixed: false,
						action: "Delete or manually fix the JSON",
					});
				} else {
					issues.push({
						type: "corrupt-track",
						message: `Run file ${file} error: ${err.message}`,
						path: runPath,
						fixed: false,
						action: "Investigate the error",
					});
				}
			}
		}
	}

	return {
		subcommand: "runs",
		checked: relevantTracks.length,
		fixed,
		issues,
		ok: issues.length === 0,
	};
}

function findPlanByName(filename: string): string[] {
	const phasesDir = ".planning/phases";
	const matches: string[] = [];

	if (!existsSync(phasesDir)) return matches;

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const dir of dirs) {
		const phaseDir = join(phasesDir, dir);
		const candidate = join(phaseDir, filename);
		if (existsSync(candidate)) {
			matches.push(candidate);
		}
	}

	return matches;
}

// ============================================================================
// Paths repair - Normalize absolute paths to relative
// ============================================================================

function repairPaths(dryRun: boolean): RepairResult {
	const issues: RepairIssue[] = [];
	let fixed = 0;

	const tracks = listRuns();

	for (const track of tracks) {
		if (!track.plan_path) continue;

		const normalized = normalizePlanPath(track.plan_path);

		// If path changed, it was absolute and got normalized
		if (normalized !== track.plan_path) {
			const issue: RepairIssue = {
				type: "absolute-path",
				message: `Run ${track.id} has absolute path`,
				path: track.plan_path,
				fixed: false,
				action: `Normalize to: ${normalized}`,
			};

			if (!dryRun) {
				track.plan_path = normalized;
				track.updated = new Date().toISOString();
				saveRun(track);
				issue.fixed = true;
				fixed++;
			}

			issues.push(issue);
		}
	}

	return {
		subcommand: "paths",
		checked: tracks.length,
		fixed,
		issues,
		ok: issues.length === 0,
	};
}

// ============================================================================
// Summaries repair - Regenerate missing/malformed SUMMARY.md
// ============================================================================

function repairSummaries(dryRun: boolean): RepairResult {
	const issues: RepairIssue[] = [];
	let fixed = 0;

	const tracks = listRuns();

	// Only check tracks that should have summaries (complete or verifying)
	const relevantTracks = tracks.filter(
		(t) => t.state === "complete" || t.state.startsWith("verifying"),
	);

	for (const track of relevantTracks) {
		const summaryPath = track.plan_path.replace(/-PLAN\.md$/, "-SUMMARY.md");

		if (!existsSync(summaryPath)) {
			const issue: RepairIssue = {
				type: "missing-summary",
				message: `Run ${track.id} (${track.state}) has no SUMMARY.md`,
				path: summaryPath,
				fixed: false,
				action: `tiller summary generate ${track.id}`,
			};

			if (!dryRun) {
				try {
					execSync(`tiller summary generate ${track.id}`, { stdio: "pipe" });
					issue.fixed = true;
					fixed++;
				} catch (e) {
					issue.action = `Failed to generate: ${(e as Error).message}`;
				}
			}

			issues.push(issue);
		} else {
			// Check if it's a template
			const content = readFileSync(summaryPath, "utf-8");
			if (isTemplate(content)) {
				const issue: RepairIssue = {
					type: "template-summary",
					message: `Run ${track.id} SUMMARY.md appears to be a template`,
					path: summaryPath,
					fixed: false,
					action: `tiller summary generate ${track.id} --force`,
				};

				if (!dryRun) {
					try {
						execSync(`tiller summary generate ${track.id} --force`, {
							stdio: "pipe",
						});
						issue.fixed = true;
						fixed++;
					} catch (e) {
						issue.action = `Failed to regenerate: ${(e as Error).message}`;
					}
				}

				issues.push(issue);
			}
		}
	}

	return {
		subcommand: "summaries",
		checked: relevantTracks.length,
		fixed,
		issues,
		ok: issues.length === 0,
	};
}

function isTemplate(content: string): boolean {
	const templateMarkers = [
		"[TODO:",
		"{{",
		"}}",
		"<placeholder>",
		"[FILL IN",
		"[ADD ",
		"<!-- TODO",
		"<!-- EXPAND",
	];
	return templateMarkers.some((marker) => content.includes(marker));
}

// ============================================================================
// Frontmatter repair - Add missing required fields
// ============================================================================

const REQUIRED_FRONTMATTER = ["phase", "plan", "type", "title"];

function repairFrontmatter(dryRun: boolean): RepairResult {
	const issues: RepairIssue[] = [];
	let fixed = 0;
	let checked = 0;

	const phasesDir = ".planning/phases";
	if (!existsSync(phasesDir)) {
		return {
			subcommand: "frontmatter",
			checked: 0,
			fixed: 0,
			issues: [],
			ok: true,
		};
	}

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	for (const dir of dirs) {
		const phaseDir = join(phasesDir, dir);
		const files = readdirSync(phaseDir).filter((f) => f.endsWith("-PLAN.md"));

		for (const file of files) {
			const planPath = join(phaseDir, file);
			checked++;

			const content = readFileSync(planPath, "utf-8");
			const frontmatter = parseFrontmatter(content);
			const missing: string[] = [];

			// Check required fields
			for (const field of REQUIRED_FRONTMATTER) {
				if (!(field in frontmatter)) {
					missing.push(field);
				}
			}

			if (missing.length > 0) {
				const issue: RepairIssue = {
					type: "missing-frontmatter",
					message: `${planPath}: missing fields: ${missing.join(", ")}`,
					path: planPath,
					fixed: false,
				};

				// Attempt auto-fix by inferring values
				if (!dryRun) {
					const inferred = inferFrontmatter(content, dir, file, frontmatter);
					const newContent = updateFrontmatter(content, {
						...frontmatter,
						...inferred,
					});

					if (Object.keys(inferred).length > 0) {
						writeFileSync(planPath, newContent);
						issue.fixed = true;
						issue.action = `Added: ${Object.keys(inferred).join(", ")}`;
						fixed++;
					}
				} else {
					issue.action = "Run without --dry-run to auto-fix";
				}

				issues.push(issue);
			}
		}
	}

	return {
		subcommand: "frontmatter",
		checked,
		fixed,
		issues,
		ok: issues.length === 0,
	};
}

function parseFrontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};

	const lines = match[1].split("\n");
	const result: Record<string, unknown> = {};

	for (const line of lines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();

		if (!key) continue;

		// Handle arrays like [a, b] or ["a", "b"]
		if (value.startsWith("[")) {
			try {
				result[key] = JSON.parse(value.replace(/'/g, '"'));
			} catch {
				result[key] = value;
			}
		} else if (value === "true") {
			result[key] = true;
		} else if (value === "false") {
			result[key] = false;
		} else if (/^\d+$/.test(value)) {
			result[key] = parseInt(value, 10);
		} else {
			result[key] = value.replace(/^["']|["']$/g, "");
		}
	}

	return result;
}

function inferFrontmatter(
	content: string,
	dirName: string,
	fileName: string,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const inferred: Record<string, unknown> = {};

	// Infer phase from directory name
	if (!existing.phase) {
		inferred.phase = dirName;
	}

	// Infer plan number from filename: "06.6-09-PLAN.md" -> 9
	if (!existing.plan) {
		const match = fileName.match(/(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/);
		if (match) {
			inferred.plan = parseInt(match[2], 10);
		}
	}

	// Default type to "execute"
	if (!existing.type) {
		inferred.type = "execute";
	}

	// Infer title from objective section
	if (!existing.title) {
		const objectiveMatch = content.match(
			/<objective>\s*(.*?)(?:\n|<\/objective>)/s,
		);
		if (objectiveMatch) {
			// Take first line of objective, clean it up
			const firstLine = objectiveMatch[1].trim().split("\n")[0];
			if (firstLine && firstLine.length > 0) {
				// Truncate if too long
				inferred.title =
					firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
			}
		}
	}

	return inferred;
}

function updateFrontmatter(
	content: string,
	newFrontmatter: Record<string, unknown>,
): string {
	const match = content.match(/^---\n([\s\S]*?)\n---/);

	const formatValue = (value: unknown): string => {
		if (Array.isArray(value)) {
			return JSON.stringify(value);
		}
		if (typeof value === "string" && value.includes(" ")) {
			return `"${value}"`;
		}
		return String(value);
	};

	const lines = Object.entries(newFrontmatter)
		.map(([key, value]) => `${key}: ${formatValue(value)}`)
		.join("\n");

	const newFrontmatterBlock = `---\n${lines}\n---`;

	if (match) {
		return content.replace(/^---\n[\s\S]*?\n---/, newFrontmatterBlock);
	}

	return `${newFrontmatterBlock}\n\n${content}`;
}

// ============================================================================
// All repairs combined
// ============================================================================

interface RepairAllOptions {
	dryRun: boolean;
	deleteOrphans: boolean;
	verbose: boolean;
}

function repairAll(options: RepairAllOptions): RepairResult[] {
	const { dryRun, deleteOrphans, verbose } = options;
	return [
		repairNumbering(dryRun),
		repairTracks({ dryRun, deleteOrphans, dedupe: false, backfillInitiative: false, verbose }),
		repairPaths(dryRun),
		repairSummaries(dryRun),
		repairFrontmatter(dryRun),
	];
}

// ============================================================================
// CLI output formatting
// ============================================================================

function printResult(result: RepairResult): void {
	const icon = result.ok ? "✓" : "⚠";
	console.log(
		`\n${icon} ${result.subcommand}: ${result.checked} checked, ${result.fixed} fixed`,
	);

	if (result.issues.length > 0) {
		for (const issue of result.issues) {
			const statusIcon = issue.fixed ? "✓" : "✗";
			console.log(`  ${statusIcon} [${issue.type}] ${issue.message}`);
			if (issue.action) {
				console.log(`    → ${issue.action}`);
			}
		}
	}
}

// ============================================================================
// Command registration
// ============================================================================

export function registerRepairCommand(program: Command): void {
	// Parent command is a pure namespace - NO action handler
	// This allows subcommand options (--dry-run, --json) to work correctly
	// See: Commander.js issue #1307 - subcommands cannot share options with parent that has action
	const repair = program
		.command("repair")
		.description("Fix structural issues in planning artifacts");

	// Subcommand: all (run all repairs)
	repair
		.command("all")
		.description("Run all repair subcommands")
		.option("--dry-run", "Show what would be fixed without making changes (default)")
		.option("--execute", "Actually apply fixes (overrides dry-run default)")
		.option("--delete-orphans", "Delete orphaned runs that reference missing plans")
		.option("--verbose", "Show detailed progress for each run checked")
		.option("--json", "Output as JSON")
		.action((opts: { dryRun?: boolean; execute?: boolean; deleteOrphans?: boolean; verbose?: boolean; json?: boolean }) => {
			// Dry-run by default, unless --execute is specified
			const dryRun = opts.execute ? false : (opts.dryRun ?? true);

			const results = repairAll({
				dryRun,
				deleteOrphans: opts.deleteOrphans ?? false,
				verbose: opts.verbose ?? false,
			});

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
				return;
			}

			console.log("tiller repair all");
			if (dryRun) {
				console.log("⚠ DRY RUN - no changes will be made. Add --execute to apply fixes.\n");
			}
			for (const result of results) {
				printResult(result);
			}

			const totalIssues = results.reduce(
				(sum, r) => sum + r.issues.length,
				0,
			);
			const totalFixed = results.reduce((sum, r) => sum + r.fixed, 0);
			console.log(`\nTotal: ${totalIssues} issue(s), ${totalFixed} fixed.`);
			if (dryRun && totalIssues > 0) {
				console.log("Add --execute to apply fixes.");
			}
		});

	// Subcommand: numbering
	repair
		.command("numbering")
		.description("Detect/fix phase number collisions")
		.option("--dry-run", "Show what would be fixed without making changes (default)")
		.option("--execute", "Actually apply fixes (overrides dry-run default)")
		.option("--json", "Output as JSON")
		.action((opts: { dryRun?: boolean; execute?: boolean; json?: boolean }) => {
			const dryRun = opts.execute ? false : (opts.dryRun ?? true);
			const result = repairNumbering(dryRun);

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			console.log("tiller repair numbering");
			printResult(result);
		});

	// Subcommand: runs (ADR-0004: "runs" is canonical terminology)
	repair
		.command("runs")
		.alias("tracks") // backward compat
		.description("Fix orphaned runs, broken paths, duplicates, and missing initiative")
		.option("--dry-run", "Show what would be fixed without making changes (default)")
		.option("--execute", "Actually apply fixes (overrides dry-run default)")
		.option("--delete-orphans", "Delete orphaned runs that reference missing plans")
		.option("--dedupe", "Remove duplicate runs for the same plan (keeps best: has initiative, active state)")
		.option("--backfill-initiative", "Set initiative from plan_path for runs missing it")
		.option("--verbose", "Show each run being checked and what checks are performed")
		.option("--json", "Output as JSON")
		.action((opts: { dryRun?: boolean; execute?: boolean; deleteOrphans?: boolean; dedupe?: boolean; backfillInitiative?: boolean; verbose?: boolean; json?: boolean }) => {
			// Dry-run by default, unless --execute is specified
			const dryRun = opts.execute ? false : (opts.dryRun ?? true);

			const result = repairTracks({
				dryRun,
				deleteOrphans: opts.deleteOrphans ?? false,
				dedupe: opts.dedupe ?? false,
				backfillInitiative: opts.backfillInitiative ?? false,
				verbose: opts.verbose ?? false,
			});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			console.log("tiller repair runs");
			if (dryRun && result.issues.length > 0) {
				console.log("⚠ DRY RUN - no changes made. Add --execute to apply fixes.\n");
			}
			printResult(result);
		});

	// Subcommand: paths
	repair
		.command("paths")
		.description("Normalize absolute paths to relative for portability")
		.option("--dry-run", "Show what would be fixed without making changes (default)")
		.option("--execute", "Actually apply fixes (overrides dry-run default)")
		.option("--json", "Output as JSON")
		.action((opts: { dryRun?: boolean; execute?: boolean; json?: boolean }) => {
			const dryRun = opts.execute ? false : (opts.dryRun ?? true);
			const result = repairPaths(dryRun);

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			console.log("tiller repair paths");
			printResult(result);
		});

	// Subcommand: summaries
	repair
		.command("summaries")
		.description("Regenerate missing/malformed SUMMARY.md files")
		.option("--dry-run", "Show what would be fixed without making changes (default)")
		.option("--execute", "Actually apply fixes (overrides dry-run default)")
		.option("--json", "Output as JSON")
		.action((opts: { dryRun?: boolean; execute?: boolean; json?: boolean }) => {
			const dryRun = opts.execute ? false : (opts.dryRun ?? true);
			const result = repairSummaries(dryRun);

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			console.log("tiller repair summaries");
			printResult(result);
		});

	// Subcommand: frontmatter
	repair
		.command("frontmatter")
		.description("Add missing required frontmatter fields")
		.option("--dry-run", "Show what would be fixed without making changes (default)")
		.option("--execute", "Actually apply fixes (overrides dry-run default)")
		.option("--json", "Output as JSON")
		.action((opts: { dryRun?: boolean; execute?: boolean; json?: boolean }) => {
			const dryRun = opts.execute ? false : (opts.dryRun ?? true);
			const result = repairFrontmatter(dryRun);

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			console.log("tiller repair frontmatter");
			printResult(result);
		});
}
