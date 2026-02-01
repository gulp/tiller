/**
 * Tiller remediate command
 *
 * Generates FIX-PLAN.md from UAT issues for human execution.
 * This is UAT/plan remediation - creating work plans for humans.
 *
 * Separate from structural "fix" operations (ADR-0006) which propose
 * machine diffs for repair to commit.
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { logEvent } from "../state/events.js";
import { applyTransition, listRuns, loadRun } from "../state/run.js";
import type { Run, RunState } from "../types/index.js";
import { matchState } from "../types/index.js";
import { escapeShellArg } from "../utils/shell.js";
import {
	extractUATIssues,
	type FixPlan,
	generateFixPlanContent,
	generateFixTasks,
	getFixPlanPath,
} from "../verification/index.js";

export function registerRemediateCommand(program: Command): void {
	program
		.command("remediate [ref]")
		.description("Generate FIX-PLAN.md from UAT issues (human work planning)")
		.option("--dry-run", "Show what would be generated without writing")
		.option("--import", "Import fix plan to beads")
		.option("--done", "Mark fix as complete, ready for re-test")
		.action(
			async (
				ref?: string,
				options?: { dryRun?: boolean; import?: boolean; done?: boolean },
			) => {
				// Find run
				let run: Run | null = null;

				if (ref) {
					run = loadRun(ref);
					if (!run) {
						console.error(`Run not found: ${ref}`);
						process.exit(2);
					}
				} else {
					// Find run in verifying/failed state first (preferred)
					const failedRuns = listRuns("verifying/failed");
					if (failedRuns.length > 0) {
						run = failedRuns[0];
					} else {
						// Try any verifying state
						const verifyingRuns = listRuns("verifying");
						if (verifyingRuns.length > 0) {
							run = verifyingRuns[0];
						}
					}

					if (!run) {
						console.error("No verifying run found. Specify plan ref.");
						console.error("Run `tiller uat` or `tiller verify` first.");
						process.exit(1);
					}
				}

				// Handle --done flag: mark fix as complete
				if (options?.done) {
					if (run.state !== "verifying/fixing") {
						console.error(
							`Cannot mark fix done: run is in '${run.state}', not 'verifying/fixing'`,
						);
						process.exit(1);
					}

					const transition = applyTransition(
						run,
						"verifying/retesting" as RunState,
						"human",
					);
					if (!transition.success) {
						console.error(`Failed to transition: ${transition.error}`);
						process.exit(1);
					}

					logEvent({
						event: "fix_completed",
						run: run.id,
					});

					console.log(`Run ${run.id}: fix complete`);
					console.log(`State: ${run.state}`);
					console.log(`\nNext: tiller verify ${run.id}`);
					return;
				}

				// Validate state - must be in verifying/* state
				if (!matchState(run.state, "verifying")) {
					console.error(
						`Run must be in verifying/* state to generate fix plan.`,
					);
					console.error(`Current state: ${run.state}`);
					console.error(`Run \`tiller verify\` or \`tiller uat\` first.`);
					process.exit(1);
				}

				// Check for UAT issues
				if (!run.verification?.uat) {
					console.error("No UAT results found on run.");
					console.error(
						"Run `tiller uat` first to perform user acceptance testing.",
					);
					process.exit(1);
				}

				// Extract issues
				const issues = extractUATIssues(run);
				if (issues.length === 0) {
					console.log("No UAT issues found. All tests passed!");
					console.log("Run `tiller complete` to finish the run.");
					process.exit(0);
				}

				// Generate fix tasks
				const tasks = generateFixTasks(issues);

				// Build fix plan
				const plan: FixPlan = {
					phase: run.id,
					plan: "fix",
					issues,
					tasks,
				};

				// Generate content
				const content = generateFixPlanContent(plan, run);
				const outputPath = getFixPlanPath(run);

				if (options?.dryRun) {
					console.log("=== FIX-PLAN.md (dry run) ===\n");
					console.log(content);
					console.log("\n=== Would write to:", outputPath, "===");
					return;
				}

				// Write file
				writeFileSync(outputPath, content);

				logEvent({
					event: "fix_plan_created",
					run: run.id,
					path: outputPath,
					issues_count: issues.length,
					tasks_count: tasks.length,
				});

				// Transition to verifying/fixing state
				const transition = applyTransition(
					run,
					"verifying/fixing" as RunState,
					"agent",
				);
				if (!transition.success) {
					console.warn(
						`Warning: Could not transition to verifying/fixing: ${transition.error}`,
					);
				}

				// Display summary
				console.log(`Fix plan created: ${outputPath}\n`);
				console.log("Issues addressed:");
				for (const issue of issues) {
					console.log(`  - ${issue.id}: ${issue.feature} (${issue.severity})`);
				}
				console.log(`\nTasks: ${tasks.length}`);
				console.log(`Run state: ${run.state}`);

				// Import to beads if requested
				if (options?.import) {
					console.log("\nImporting to beads...");
					try {
						// Extract plan name from path for the beads task title
						const planName =
							outputPath.split("/").pop()?.replace(".md", "") || "Fix Plan";
						const title = `Fix: ${planName}`;
						const parentArg = run.beads_epic_id
							? `--parent=${run.beads_epic_id}`
							: "";

						const output = execSync(
							`bd create --type=task ${parentArg} --title="${escapeShellArg(title)}"`,
							{
								encoding: "utf-8",
							},
						);
						const match = output.match(/([a-z]+-[a-z0-9]+)/i);
						const taskId = match ? match[1] : null;

						if (taskId) {
							console.log(`Created beads task: ${taskId}`);
							logEvent({
								event: "fix_plan_imported",
								run: run.id,
								beads_task: taskId,
							});
						}
					} catch (e) {
						console.warn("Warning: Failed to import to beads:", e);
					}
				} else {
					console.log(
						`\nRun \`tiller remediate --import\` or \`tiller init ${outputPath}\` to import to beads.`,
					);
				}
			},
		);
}
