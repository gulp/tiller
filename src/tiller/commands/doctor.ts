/**
 * Tiller doctor command - Verify alignment between runs and SUMMARY.md artifacts
 *
 * Commands:
 * - doctor     Check run→SUMMARY alignment for complete/verifying runs
 *              Check contract compliance for v0.2.0 multi-initiative support
 */

import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { listRuns, loadRun } from "../state/run.js";
import type { Run } from "../types/index.js";
import { matchState } from "../types/index.js";
import {
	checkDrift,
	isTemplate,
	querySummary,
	type SummaryQueryType,
} from "./summary.js";

// Contract compliance check result
interface ContractCheckResult {
	name: string;
	status: "ok" | "warning" | "error";
	message: string;
	fix?: string;
	initiative?: string;
}

// Alignment check result for a single run
interface AlignmentCheck {
	run_id: string;
	run_state: string;
	summary_path: string;
	checks: {
		exists: boolean;
		structure: {
			objective: boolean;
			deliverables: boolean;
			tasks: boolean;
			verification: boolean;
			commits: boolean; // Only required for complete tracks
		};
		is_template: boolean;
		task_count: {
			run: number;
			summary: number;
			aligned: boolean;
		};
		drift: {
			checked: boolean;
			has_drift: boolean;
			details?: {
				missing_deliverables: string[];
				missing_commits: string[];
			};
		};
	};
	issues: string[];
	fix_commands: string[];
	ok: boolean;
}

// Doctor result for all tracks
interface DoctorResult {
	checked: number;
	passed: number;
	failed: number;
	tracks: AlignmentCheck[];
	contract: ContractCheckResult[];
}

/**
 * Check contract compliance for v0.2.0 multi-initiative support
 */
function checkContractCompliance(): ContractCheckResult[] {
	const results: ContractCheckResult[] = [];
	const tracks = listRuns();

	// Check 1: All tracks have initiative (v0.2.0 requirement)
	const legacyTracks = tracks.filter((t) => !t.initiative);
	if (legacyTracks.length > 0) {
		results.push({
			name: "contract/initiative-prefix",
			status: "warning",
			message: `${legacyTracks.length} track(s) without initiative prefix (legacy format)`,
			fix: "Run tiller migrate <initiative> to update track IDs",
		});
		// Add individual track warnings
		for (const track of legacyTracks) {
			results.push({
				name: `contract/legacy-track/${track.id}`,
				status: "warning",
				message: `Run ${track.id} uses legacy format`,
				fix: `Run tiller migrate <initiative> to update`,
			});
		}
	}

	// Check 2: PLAN paths match ADR-0005 contract structure
	for (const track of tracks) {
		if (track.plan_path && !track.plan_path.startsWith("plans/")) {
			results.push({
				name: `contract/path/${track.id}`,
				status: "warning",
				message: `Run ${track.id} uses legacy path: ${track.plan_path}`,
				fix: "Migrate to plans/{initiative}/{phase}/... per ADR-0005",
				initiative: track.initiative ?? undefined,
			});
		}
	}

	// Check 3: STATE.md has split sections for each initiative
	const initiatives = [
		...new Set(tracks.map((t) => t.initiative).filter(Boolean)),
	] as string[];
	for (const init of initiatives) {
		const statePath = `specs/${init}/STATE.md`;
		if (existsSync(statePath)) {
			const content = readFileSync(statePath, "utf-8");
			const hasProposed = content.includes("## Proposed");
			const hasAuthoritative = content.includes("## Authoritative");

			if (!hasProposed || !hasAuthoritative) {
				const missing = [];
				if (!hasProposed) missing.push("## Proposed");
				if (!hasAuthoritative) missing.push("## Authoritative");

				results.push({
					name: `contract/state-sections/${init}`,
					status: "error",
					message: `STATE.md for ${init} missing: ${missing.join(", ")}`,
					fix: "Add split ownership sections per contract spec",
					initiative: init,
				});
			} else {
				results.push({
					name: `contract/state-sections/${init}`,
					status: "ok",
					message: `STATE.md for ${init} has required sections`,
					initiative: init,
				});
			}
		}
	}

	// Check 4: Run state aligns with SUMMARY files (detect state drift)
	for (const track of tracks) {
		const planDir = track.plan_path.replace(/-PLAN\.md$/, "");
		const summaryDone = `${planDir}-SUMMARY.done.md`;
		const summaryAutopass = `${planDir}-SUMMARY.autopass.md`;

		// Check for .done.md → should be complete
		if (existsSync(summaryDone) && track.state !== "complete") {
			results.push({
				name: `state-drift/${track.id}/done`,
				status: "error",
				message: `Run ${track.id} has SUMMARY.done.md but state is ${track.state}`,
				fix: "Run: tiller repair runs --execute",
				initiative: track.initiative ?? undefined,
			});
		}

		// Check for .autopass.md → should be verifying/passed or complete
		if (
			existsSync(summaryAutopass) &&
			!track.state.startsWith("verifying") &&
			track.state !== "complete"
		) {
			results.push({
				name: `state-drift/${track.id}/autopass`,
				status: "error",
				message: `Run ${track.id} has SUMMARY.autopass.md but state is ${track.state}`,
				fix: "Run: tiller repair runs --execute",
				initiative: track.initiative ?? undefined,
			});
		}
	}

	return results;
}

/**
 * Check alignment for a single track
 */
function checkRunAlignment(run: Run): AlignmentCheck {
	const summaryPath = run.plan_path.replace(/-PLAN\.md$/, "-SUMMARY.md");
	const isComplete = run.state === "complete";

	const result: AlignmentCheck = {
		run_id: run.id,
		run_state: run.state,
		summary_path: summaryPath,
		checks: {
			exists: false,
			structure: {
				objective: false,
				deliverables: false,
				tasks: false,
				verification: false,
				commits: false,
			},
			is_template: false,
			task_count: {
				run: run.beads_snapshot?.tasks?.length ?? 0,
				summary: 0,
				aligned: false,
			},
			drift: {
				checked: false,
				has_drift: false,
			},
		},
		issues: [],
		fix_commands: [],
		ok: true,
	};

	// Check 1: File exists
	if (!existsSync(summaryPath)) {
		result.checks.exists = false;
		result.issues.push("SUMMARY.md not found");
		result.fix_commands.push(`tiller summary generate ${run.id}`);
		result.ok = false;
		return result;
	}
	result.checks.exists = true;

	// Read content for remaining checks
	const content = readFileSync(summaryPath, "utf-8");

	// Check 2: Template detection
	result.checks.is_template = isTemplate(summaryPath, content);
	if (result.checks.is_template) {
		result.issues.push("File appears to be a template (contains placeholders)");
		result.fix_commands.push(`tiller summary generate ${run.id} --force`);
		result.ok = false;
		return result;
	}

	// Check 3: Structure - required sections present via MQ queries
	const sections: Array<{
		key: keyof typeof result.checks.structure;
		queryType: SummaryQueryType;
		requiredForComplete: boolean;
	}> = [
		{ key: "objective", queryType: "objective", requiredForComplete: false },
		{
			key: "deliverables",
			queryType: "deliverables",
			requiredForComplete: false,
		},
		{ key: "tasks", queryType: "tasks", requiredForComplete: false },
		{
			key: "verification",
			queryType: "verification",
			requiredForComplete: false,
		},
		{ key: "commits", queryType: "commits", requiredForComplete: true },
	];

	for (const section of sections) {
		try {
			const sectionContent = querySummary(summaryPath, section.queryType);
			const hasContent = sectionContent.length > 0;
			result.checks.structure[section.key] = hasContent;

			if (!hasContent) {
				// Only flag commits as issue for complete tracks
				if (section.key === "commits" && !isComplete) {
					continue;
				}
				result.issues.push(`Missing ${section.key} section`);
				result.ok = false;
			}
		} catch {
			result.checks.structure[section.key] = false;
			result.issues.push(`Failed to query ${section.key} section`);
			result.ok = false;
		}
	}

	// Check 4: Task count alignment
	try {
		const summaryTasks = querySummary(summaryPath, "tasks");
		result.checks.task_count.summary = summaryTasks.length;
		result.checks.task_count.aligned =
			result.checks.task_count.run === result.checks.task_count.summary ||
			result.checks.task_count.run === 0; // No track tasks is OK (not using beads)

		if (
			!result.checks.task_count.aligned &&
			result.checks.task_count.run > 0
		) {
			result.issues.push(
				`Task count mismatch: track=${result.checks.task_count.run}, summary=${result.checks.task_count.summary}`,
			);
			result.ok = false;
		}
	} catch {
		// Non-fatal - task count check failed
	}

	// Check 5: Drift detection (deliverables and commits exist)
	try {
		const driftResult = checkDrift(summaryPath);
		result.checks.drift.checked = true;
		result.checks.drift.has_drift = driftResult.drift;

		if (driftResult.drift) {
			const missingDeliverables = driftResult.deliverables
				.filter((d) => !d.exists)
				.map((d) => d.path);
			const missingCommits = driftResult.commits
				.filter((c) => !c.exists)
				.map((c) => c.hash);

			result.checks.drift.details = {
				missing_deliverables: missingDeliverables,
				missing_commits: missingCommits,
			};

			if (missingDeliverables.length > 0) {
				result.issues.push(
					`Drift: ${missingDeliverables.length} deliverable(s) not found`,
				);
			}
			if (missingCommits.length > 0) {
				result.issues.push(
					`Drift: ${missingCommits.length} commit(s) not found`,
				);
			}
			result.ok = false;
		}
	} catch {
		// Non-fatal - drift check failed
	}

	// Add fix command if issues found
	if (!result.ok && result.fix_commands.length === 0) {
		// Content drift requires manual fix
		result.fix_commands.push("Content drift detected (manual fix required)");
	}

	return result;
}

/**
 * Run doctor checks on tracks
 */
function runDoctorChecks(trackFilter?: string): DoctorResult {
	// Get tracks in complete or verifying states
	const allTracks = listRuns();
	let tracksToCheck = allTracks.filter(
		(t) => t.state === "complete" || matchState(t.state, "verifying"),
	);

	// Filter to specific track if requested
	if (trackFilter) {
		const track = loadRun(trackFilter);
		if (track) {
			tracksToCheck = [track];
		} else {
			tracksToCheck = [];
		}
	}

	const results: AlignmentCheck[] = [];
	for (const track of tracksToCheck) {
		results.push(checkRunAlignment(track));
	}

	// Run contract compliance checks (always, not filtered)
	const contractResults = checkContractCompliance();

	return {
		checked: results.length,
		passed: results.filter((r) => r.ok).length,
		failed: results.filter((r) => !r.ok).length,
		tracks: results,
		contract: contractResults,
	};
}

export function registerDoctorCommands(program: Command): void {
	program
		.command("doctor")
		.description("Check run→SUMMARY alignment for complete/verifying runs")
		.option("--json", "Output as JSON")
		.option("--run <id>", "Check specific run instead of all")
		.option("--fix", "Auto-fix issues where possible")
		.option("--gate", "Exit 1 if issues found (for programmatic use)")
		.action(
			async (options: {
				json?: boolean;
				run?: string;
				fix?: boolean;
				gate?: boolean;
			}) => {
				const result = runDoctorChecks(options.run);

				// JSON output
				if (options.json) {
					console.log(JSON.stringify(result, null, 2));
					if (options.gate) {
						process.exit(result.failed > 0 ? 1 : 0);
					}
					return;
				}

				// Human-readable output
				console.log("tiller doctor");
				console.log("");

				// Contract compliance checks (always shown)
				const contractIssues = result.contract.filter((c) => c.status !== "ok");
				if (result.contract.length > 0) {
					console.log("Contract compliance (v0.2.0):");
					for (const check of result.contract) {
						const icon =
							check.status === "ok"
								? "✓"
								: check.status === "warning"
									? "⚠"
									: "✗";
						console.log(`  ${icon} ${check.message}`);
						if (check.status !== "ok" && check.fix) {
							console.log(`    → ${check.fix}`);
						}
					}
					console.log("");
				}

				if (result.checked === 0) {
					if (options.run) {
						console.log(`No run found: ${options.run}`);
					} else {
						console.log("No runs in complete/verifying state to check.");
					}
					// Gate mode should also consider contract issues
					if (options.gate) {
						const hasContractErrors = result.contract.some(
							(c) => c.status === "error",
						);
						process.exit(hasContractErrors ? 1 : 0);
					}
					return;
				}

				console.log("Run → SUMMARY alignment:");

				for (const check of result.tracks) {
					if (check.ok) {
						const taskInfo =
							check.checks.task_count.run > 0
								? `, ${check.checks.task_count.summary}/${check.checks.task_count.run} tasks match`
								: "";
						console.log(
							`  ✓ ${check.run_id}: all sections present${taskInfo}`,
						);
					} else {
						for (const issue of check.issues) {
							console.log(`  ✗ ${check.run_id}: ${issue}`);
							// Show fix command for this specific issue
							if (check.fix_commands.length > 0) {
								const fixCmd = check.fix_commands[0];
								if (!fixCmd.includes("manual")) {
									console.log(`    → ${fixCmd}`);
								} else {
									console.log(`    → ${fixCmd}`);
								}
							}
						}
					}
				}

				// Summary
				console.log("");
				if (result.failed > 0) {
					const fixableCount = result.tracks.filter(
						(t) => !t.ok && t.fix_commands.some((c) => !c.includes("manual")),
					).length;

					console.log(
						`${result.failed} issue(s) found.${
							fixableCount > 0
								? ` Run \`tiller doctor --fix\` to auto-repair.`
								: ""
						}`,
					);

					// Auto-fix if requested
					if (options.fix) {
						console.log("");
						console.log("Attempting auto-fix...");

						for (const check of result.tracks) {
							if (!check.ok) {
								for (const cmd of check.fix_commands) {
									if (cmd.includes("manual")) {
										console.log(`  ⊘ ${check.run_id}: ${cmd}`);
									} else if (cmd.startsWith("tiller summary generate")) {
										// Execute the fix command
										console.log(`  → Running: ${cmd}`);
										try {
											const { execSync } = await import("node:child_process");
											execSync(cmd, { stdio: "inherit" });
											console.log(`  ✓ Fixed: ${check.run_id}`);
										} catch {
											console.log(`  ✗ Failed to fix: ${check.run_id}`);
										}
									}
								}
							}
						}
					}
				} else {
					console.log(`✓ All ${result.checked} run(s) aligned.`);
				}

				// Contract summary
				if (contractIssues.length > 0) {
					const contractErrors = contractIssues.filter(
						(c) => c.status === "error",
					).length;
					const contractWarnings = contractIssues.filter(
						(c) => c.status === "warning",
					).length;
					console.log("");
					if (contractErrors > 0) {
						console.log(
							`${contractErrors} contract error(s), ${contractWarnings} warning(s).`,
						);
					} else if (contractWarnings > 0) {
						console.log(`${contractWarnings} contract warning(s).`);
					}
				}

				// Gate mode exit code (consider both track issues and contract errors)
				if (options.gate) {
					const hasContractErrors = result.contract.some(
						(c) => c.status === "error",
					);
					process.exit(result.failed > 0 || hasContractErrors ? 1 : 0);
				}
			},
		);
}
