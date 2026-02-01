/**
 * UAT (User Acceptance Testing) command
 *
 * Agent-first design:
 * - Default: Returns JSON checklist for agent to use with AskUserQuestion
 * - --interactive (-I): Direct terminal prompts for human use
 * - --record: Accept results JSON from agent and store on track
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { logEvent } from "../state/events.js";
import { listRuns, loadRun, saveRun } from "../state/run.js";
import type { Run, VerificationCheck } from "../types/index.js";
import { matchState } from "../types/index.js";
import {
	extractDeliverablesAsync,
	extractEpicId,
	generateChecklist,
	getUATSummary,
	type UATCheckItem,
} from "../verification/uat.js";

/**
 * Get run by ID or find one in verifying/active state (HSM: any substate)
 */
function getRunForUAT(runId?: string): Run | null {
	if (runId) {
		return loadRun(runId);
	}

	// Find run in verifying state first, then active (HSM: any substate)
	const allRuns = listRuns();
	const verifying = allRuns.filter((r) => matchState(r.state, "verifying"));
	if (verifying.length > 0) return verifying[0];

	const active = allRuns.filter((r) => matchState(r.state, "active"));
	if (active.length > 0) return active[0];

	return null;
}

/**
 * Find SUMMARY.md for a run's plan
 */
function findSummaryPath(run: Run): string | null {
	const planPath = run.plan_path;

	// SUMMARY.md is usually in the same directory as the PLAN.md
	const dir = dirname(planPath);
	const planBase = basename(planPath, ".md");
	const summaryBase = planBase.replace("-PLAN", "-SUMMARY");
	const summaryPath = join(dir, `${summaryBase}.md`);

	if (existsSync(summaryPath)) {
		return summaryPath;
	}

	// Try without the -PLAN suffix replacement
	const altSummary = join(dir, "SUMMARY.md");
	if (existsSync(altSummary)) {
		return altSummary;
	}

	return null;
}

/**
 * Prompt user for input (single line)
 */
async function prompt(
	rl: ReturnType<typeof createInterface>,
	question: string,
): Promise<string> {
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			resolve(answer.trim());
		});
	});
}

/**
 * Parse result input
 */
function parseResult(input: string): UATCheckItem["result"] | null {
	const lower = input.toLowerCase();
	if (lower === "p" || lower === "pass") return "pass";
	if (lower === "f" || lower === "fail") return "fail";
	if (lower === "s" || lower === "skip") return "skip";
	if (lower === "partial" || lower === "pa") return "partial";
	return null;
}

/**
 * Parse severity input
 */
function parseSeverity(input: string): UATCheckItem["severity"] | null {
	const lower = input.toLowerCase();
	if (lower === "b" || lower === "blocker") return "blocker";
	if (lower === "m" || lower === "major") return "major";
	if (lower === "mi" || lower === "minor") return "minor";
	if (lower === "c" || lower === "cosmetic") return "cosmetic";
	return null;
}

/**
 * Output JSON checklist for agent consumption
 */
interface UATChecklist {
	run_id: string;
	phase: string;
	plan: string;
	intent: string;
	summary_path: string;
	checks: Array<{
		id: string;
		feature: string;
		description: string;
	}>;
}

/**
 * Input format for --record flag
 */
interface UATRecordInput {
	results: Array<{
		id: string;
		result: "pass" | "fail" | "partial" | "skip";
		issue?: string;
		severity?: "blocker" | "major" | "minor" | "cosmetic";
	}>;
}

export function registerUATCommand(program: Command): void {
	program
		.command("uat [run-id]")
		.description("User acceptance testing (default: JSON checklist for agents)")
		.option(
			"-I, --interactive",
			"Run interactive prompts in terminal (for humans)",
		)
		.option(
			"--record <json>",
			"Record results from agent (JSON string or @file)",
		)
		.action(
			async (
				runId?: string,
				options?: { interactive?: boolean; record?: string },
			) => {
				// Get run
				const run = getRunForUAT(runId);
				if (!run) {
					if (options?.interactive) {
						console.error(
							"No run found. Specify a run ID or have an active/verifying run.",
						);
					} else {
						console.log(
							JSON.stringify({ error: "No run found", code: "NO_RUN" }),
						);
					}
					process.exit(2);
				}

				// Check run state (HSM: match parent states)
				if (
					!matchState(run.state, "active") &&
					!matchState(run.state, "verifying")
				) {
					if (options?.interactive) {
						console.error(`Run ${run.id} is in '${run.state}' state.`);
						console.error(
							"Run `tiller verify` first to move to verifying state.",
						);
					} else {
						console.log(
							JSON.stringify({
								error: `Run is in '${run.state}' state, need active or verifying`,
								code: "INVALID_STATE",
								run_id: run.id,
								current_state: run.state,
							}),
						);
					}
					process.exit(1);
				}

				// Find SUMMARY.md
				const summaryPath = findSummaryPath(run);
				if (!summaryPath) {
					if (options?.interactive) {
						console.error(`No SUMMARY.md found for run ${run.id}`);
						console.error(`Expected near: ${run.plan_path}`);
					} else {
						console.log(
							JSON.stringify({
								error: "No SUMMARY.md found",
								code: "NO_SUMMARY",
								run_id: run.id,
								plan_path: run.plan_path,
							}),
						);
					}
					process.exit(1);
				}

				// Read SUMMARY.md and extract deliverables from beads epic
				const summaryContent = readFileSync(summaryPath, "utf-8");
				const epicId = extractEpicId(summaryContent);
				const deliverables = await extractDeliverablesAsync(
					summaryContent,
					epicId,
				);

				if (deliverables.length === 0) {
					if (options?.interactive) {
						console.error("No testable deliverables found in SUMMARY.md");
					} else {
						console.log(
							JSON.stringify({
								error: "No testable deliverables found in SUMMARY.md",
								code: "NO_DELIVERABLES",
								run_id: run.id,
								summary_path: summaryPath,
							}),
						);
					}
					process.exit(1);
				}

				// Generate checklist
				const checks = generateChecklist(deliverables);

				// Extract phase/plan from path
				const planPathMatch = run.plan_path.match(
					/(\d+\.?\d*)-(\d+)-PLAN\.md$/,
				);
				const phase = planPathMatch?.[1] || "unknown";
				const plan = planPathMatch?.[2] || "unknown";

				// MODE: Record results from agent
				if (options?.record) {
					let inputData: UATRecordInput;

					try {
						// Handle @file or direct JSON
						if (options.record.startsWith("@")) {
							const filePath = options.record.slice(1);
							inputData = JSON.parse(readFileSync(filePath, "utf-8"));
						} else {
							inputData = JSON.parse(options.record);
						}
					} catch {
						console.log(
							JSON.stringify({
								error: "Invalid JSON in --record",
								code: "INVALID_JSON",
							}),
						);
						process.exit(1);
					}

					const startedAt = new Date().toISOString();

					// Apply results to checks
					for (const check of checks) {
						const r = inputData.results.find((x) => x.id === check.id);
						if (r) {
							check.result = r.result;
							check.issue = r.issue;
							check.severity = r.severity;
						}
					}

					// Calculate summary
					const summary = getUATSummary(checks);

					// Store results on track
					if (!run.verification) {
						run.verification = {};
					}

					run.verification.uat = {
						checks: checks.map((c) => ({
							name: c.feature,
							command: "manual",
							status:
								c.result === "pass"
									? "pass"
									: c.result === "skip"
										? "skip"
										: "fail",
							output: c.issue ? `${c.issue} (${c.severity})` : undefined,
							ran_at: startedAt,
						})) as VerificationCheck[],
						status:
							summary.failed === 0 && summary.partial === 0 ? "pass" : "fail",
						ran_at: startedAt,
						issues_logged: summary.issues,
					};

					run.updated = new Date().toISOString();
					saveRun(run);
					logEvent({
						event: "uat_complete",
						track: run.id,
						passed: summary.passed,
						failed: summary.failed,
						issues: summary.issues,
					});

					// Output result JSON
					console.log(
						JSON.stringify({
							success: true,
							run_id: run.id,
							summary: {
								total: summary.total,
								passed: summary.passed,
								failed: summary.failed,
								partial: summary.partial,
								skipped: summary.skipped,
								issues: summary.issues,
							},
							verdict:
								summary.failed === 0 && summary.partial === 0 ? "pass" : "fail",
							next: summary.issues > 0 ? "tiller fix" : "tiller complete",
						}),
					);
					return;
				}

				// MODE: Interactive (for humans)
				if (options?.interactive) {
					const startedAt = new Date().toISOString();

					console.log("═".repeat(55));
					console.log(`UAT: ${run.intent.slice(0, 50)}`);
					console.log("═".repeat(55));
					console.log(
						`\nTesting ${checks.length} feature(s) from SUMMARY.md\n`,
					);

					const rl = createInterface({
						input: process.stdin,
						output: process.stdout,
					});

					try {
						for (let i = 0; i < checks.length; i++) {
							const check = checks[i];
							console.log(`\n[${i + 1}/${checks.length}] ${check.feature}`);
							console.log(`    ${check.description.slice(0, 70)}`);
							console.log("");

							// Get result
							let result: UATCheckItem["result"] | null = null;
							while (!result) {
								const answer = await prompt(
									rl,
									"  Result (p)ass / (f)ail / (s)kip / (pa)rtial? ",
								);
								result = parseResult(answer);
								if (!result) {
									console.log("  Invalid input. Use: p, f, s, or pa");
								}
							}
							check.result = result;

							// If fail or partial, get details
							if (result === "fail" || result === "partial") {
								check.issue = await prompt(rl, "  Describe the issue: ");

								let severity: UATCheckItem["severity"] | null = null;
								while (!severity) {
									const sev = await prompt(
										rl,
										"  Severity (b)locker / (m)ajor / (mi)nor / (c)osmetic? ",
									);
									severity = parseSeverity(sev);
									if (!severity) {
										console.log("  Invalid input. Use: b, m, mi, or c");
									}
								}
								check.severity = severity;
							}
						}
					} finally {
						rl.close();
					}

					// Calculate summary
					const summary = getUATSummary(checks);

					// Store results on track
					if (!run.verification) {
						run.verification = {};
					}

					run.verification.uat = {
						checks: checks.map((c) => ({
							name: c.feature,
							command: "manual",
							status:
								c.result === "pass"
									? "pass"
									: c.result === "skip"
										? "skip"
										: "fail",
							output: c.issue ? `${c.issue} (${c.severity})` : undefined,
							ran_at: startedAt,
						})) as VerificationCheck[],
						status:
							summary.failed === 0 && summary.partial === 0 ? "pass" : "fail",
						ran_at: startedAt,
						issues_logged: summary.issues,
					};

					run.updated = new Date().toISOString();
					saveRun(run);
					logEvent({
						event: "uat_complete",
						track: run.id,
						passed: summary.passed,
						failed: summary.failed,
						issues: summary.issues,
					});

					// Display summary
					console.log(`\n${"─".repeat(55)}`);
					console.log(
						`UAT Complete: ${summary.passed}/${summary.total} passed` +
							(summary.issues > 0 ? `, ${summary.issues} issue(s) logged` : ""),
					);
					console.log("");

					for (const check of checks) {
						const icon =
							check.result === "pass"
								? "✓"
								: check.result === "skip"
									? "○"
									: check.result === "partial"
										? "◐"
										: "✗";
						console.log(`  ${icon} ${check.feature}`);
						if (check.issue) {
							console.log(`      (${check.severity}): ${check.issue}`);
						}
					}

					if (summary.issues > 0) {
						console.log(
							"\nIssues logged to track. Run `tiller fix` to create fix plan.",
						);
					} else {
						console.log("\nAll tests passed! Run `tiller complete` to finish.");
					}
					return;
				}

				// MODE: Default - JSON checklist for agent
				const output: UATChecklist = {
					run_id: run.id,
					phase,
					plan,
					intent: run.intent,
					summary_path: summaryPath,
					checks: checks.map((c) => ({
						id: c.id,
						feature: c.feature,
						description: c.description,
					})),
				};

				console.log(JSON.stringify(output, null, 2));
			},
		);
}
