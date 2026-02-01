/**
 * tiller init command - Create runs from PLAN.md files
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { ensureTillerDir } from "../state/config.js";
import { logEvent } from "../state/events.js";
import { normalizePlanPath } from "../state/paths.js";
import {
	type InitiativeInfo,
	parseInitiativeFromPath,
} from "../state/initiative.js";
import { generateRunId, listRuns, saveRun } from "../state/run.js";
import type { Run } from "../types/index.js";
import { resolveRef } from "../utils/ref.js";
import { escapeShellArg } from "../utils/shell.js";

export function registerInitCommand(program: Command): void {
	program
		.command("init <ref>")
		.description(
			"Create runs from plan ref (06.6-25), phase ID (06.6), or path",
		)
		.option("--no-beads", "Skip beads import (run only)")
		.option("--dry-run", "Show what would be created without creating")
		.action(
			async (input: string, options: { beads: boolean; dryRun: boolean }) => {
				ensureTillerDir();

				// Try to resolve input as plan ref or phase ID (agent-first: tolerant parsing)
				let path = input;
				const resolved = resolveRef(input);
				if (resolved) {
					path = resolved.path;
				} else if (!existsSync(input)) {
					// Ref didn't resolve and path doesn't exist
					console.error(`Plan not found: ${input}`);
					console.error(`\nTried to resolve as:`);
					console.error(`  - Plan ref (e.g., 08-14, 06.6-25)`);
					console.error(`  - Phase ID (e.g., 08, 06.6)`);
					console.error(`  - File path`);
					console.error(`\nCheck: tiller list --all  (to see available plans)`);
					process.exit(2);
				}

				// Determine if path is directory or file
				const isDir = existsSync(path) && !path.endsWith(".md");
				const planFiles = isDir ? findPlanFiles(path) : [path];

				if (planFiles.length === 0) {
					console.error(`No PLAN.md files found in: ${path}`);
					process.exit(2);
				}

				// Check for existing runs
				const existingRuns = listRuns();
				const existingPaths = new Set(existingRuns.map((r) => r.plan_path));

				const toCreate = planFiles.filter((p) => !existingPaths.has(p));
				const skipped = planFiles.filter((p) => existingPaths.has(p));

				if (skipped.length > 0) {
					console.log(`Skipping ${skipped.length} existing run(s):`);
					skipped.forEach((p) => console.log(`  - ${basename(p)}`));
				}

				if (toCreate.length === 0) {
					console.log("All plans already have runs.");
					return;
				}

				if (options.dryRun) {
					console.log("\nWould create runs for:");
					toCreate.forEach((p) => console.log(`  - ${p}`));
					return;
				}

				// Create phase epic in beads if multiple plans
				let epicId: string | null = null;
				if (options.beads && toCreate.length > 1) {
					const phaseName = extractPhaseName(path);
					try {
						const output = execSync(
							`bd create --type=epic --title="${escapeShellArg(phaseName)}" --json`,
							{
								encoding: "utf-8",
							},
						).trim();
						// Parse JSON output to extract issue ID
						try {
							const json = JSON.parse(output);
							epicId = json.id || null;
						} catch {
							epicId = null;
						}
						console.log(`Created beads epic: ${epicId}`);
					} catch (e) {
						console.warn("Warning: Could not create beads epic:", e);
						epicId = null;
					}
				}

				// Process each plan file
				const runs: Run[] = [];
				for (const planPath of toCreate) {
					const content = readFileSync(planPath, "utf-8");
					const frontmatter = parseFrontmatter(content);
					const intent = extractObjective(content);

					// Parse initiative from path
					let initiativeInfo: InitiativeInfo;
					try {
						initiativeInfo = parseInitiativeFromPath(planPath);
					} catch (e) {
						console.error(`Error parsing path: ${(e as Error).message}`);
						process.exit(2);
					}

					// Warn for legacy paths
					if (!initiativeInfo.isContractCompliant) {
						console.warn(
							`⚠ Legacy path detected. Use plans/{initiative}/{phase}/... per ADR-0005.`,
						);
					}

					// Generate immutable run ID (plan_ref derived from plan_path)
					const runId = generateRunId();

					// Link to existing bead or create new one
					let beadsTaskId: string | null = null;

					// Priority 1: Use bead_ref from frontmatter (set by tiller collect)
					if (
						frontmatter.bead_ref &&
						typeof frontmatter.bead_ref === "string"
					) {
						beadsTaskId = frontmatter.bead_ref;
					}
					// Priority 2: Create new bead if --beads flag and no existing bead_ref
					else if (options.beads) {
						try {
							const parentArg = epicId ? `--parent=${epicId}` : "";
							const planNum =
								frontmatter.plan ||
								basename(planPath).match(/(\d+-\d+)/)?.[1] ||
								"??";
							const title = `${planNum}: ${intent.slice(0, 50)}`;
							const output = execSync(
								`bd create --type=task ${parentArg} --title="${escapeShellArg(title)}" --json`,
								{
									encoding: "utf-8",
								},
							).trim();
							// Parse JSON output to extract issue ID
							try {
								const json = JSON.parse(output);
								beadsTaskId = json.id || null;
							} catch {
								beadsTaskId = null;
							}
						} catch (e) {
							console.warn(
								`Warning: Could not create beads task for ${planPath}:`,
								e,
							);
						}
					}

					// Create run with initiative
					// Use 'ready' state - if you're running init, you want to execute
					// (proposed state is for external submissions needing review)
					const now = new Date().toISOString();
					const run: Run = {
						id: runId,
						initiative: initiativeInfo.initiative,
						intent,
						state: "ready",
						plan_path: normalizePlanPath(planPath),
						created: now,
						updated: now,
						transitions: [],
						checkpoints: [],
						beads_epic_id: epicId,
						beads_task_id: beadsTaskId,
						beads_snapshot: null,
						claimed_by: null,
						claimed_at: null,
						claim_expires: null,
						files_touched: Array.isArray(frontmatter.files_modified)
							? frontmatter.files_modified
							: [],
						priority: 99,
						depends_on: Array.isArray(frontmatter.depends_on)
							? frontmatter.depends_on
							: [],
					};

					saveRun(run);
					runs.push(run);
					logEvent({
						event: "run_created",
						track: run.id,
						plan: planPath,
						beads: beadsTaskId,
					});

					console.log(
						`  ✓ ${run.id} → ${beadsTaskId || "no beads"} [${basename(planPath)}]`,
					);
				}

				// Import dependencies to beads
				if (options.beads && runs.some((r) => r.beads_task_id)) {
					importDependencies(runs);
				}

				console.log(`\nCreated ${runs.length} run(s) in 'ready' state`);
				if (epicId) {
					console.log(
						`\nNext: tiller start <ref> (or bd ready --parent=${epicId})`,
					);
				} else {
					console.log(`\nNext: tiller start <ref>`);
				}
			},
		);
}

function findPlanFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const files = readdirSync(dir)
		.filter((f) => f.endsWith("-PLAN.md"))
		.map((f) => join(dir, f))
		.sort();

	return files;
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
		} else {
			result[key] = value;
		}
	}

	return result;
}

function extractObjective(content: string): string {
	const match = content.match(/<objective>\s*([^<]+)/);
	if (match) {
		// Get first paragraph (up to double newline or first 100 chars)
		const text = match[1].trim();
		const firstPara = text.split(/\n\n/)[0];
		return firstPara.split("\n")[0].slice(0, 100);
	}
	return "No objective found";
}

function extractPhaseName(path: string): string {
	// Extract "Phase 02: Tiller CLI Core" from directory name
	const match = path.match(/(\d+)-([^/]+)/);
	if (match) {
		const num = match[1];
		const name = match[2]
			.replace(/-/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase());
		return `Phase ${num}: ${name}`;
	}
	return basename(path);
}

function importDependencies(runs: Run[]): void {
	// Build map of plan ID to beads task ID
	const planToBeads: Record<string, string> = {};
	for (const r of runs) {
		const planId = r.plan_path.match(/(\d+-\d+)-PLAN/)?.[1];
		if (planId && r.beads_task_id) {
			planToBeads[planId] = r.beads_task_id;
		}
	}

	// Add dependencies
	for (const r of runs) {
		if (!r.beads_task_id) continue;

		const deps = r.depends_on || [];
		for (const dep of deps) {
			const depBeadsId = planToBeads[dep];
			if (depBeadsId) {
				try {
					execSync(`bd dep add ${r.beads_task_id} ${depBeadsId}`);
					console.log(`  dep: ${r.beads_task_id} depends on ${depBeadsId}`);
				} catch (e) {
					console.warn(`Warning: Could not add dependency:`, e);
				}
			}
		}
	}
}
