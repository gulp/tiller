/**
 * Tiller run command group - Execution lifecycle for runs
 *
 * ADR-0004: Runtime commands operate on RUNs
 *
 * Commands:
 * - run start   ready → active/executing (precise run creation)
 * - run pause   active/executing → active/paused
 * - run resume  active/paused → active/executing
 * - run verify  active/* → verifying/testing (engine determines outcome)
 * - run complete verifying/passed → complete
 *
 * Note: `tiller start` (collapsed convenience flow) remains separate and unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { getRequireSummary } from "../state/config.js";
import { readPlanFile } from "../state/paths.js";
import { outputConstitutional } from "../state/constitutional.js";
import { logEvent } from "../state/events.js";
import {
	appendVerificationEvent,
	applyTransition,
	deriveVerificationSnapshot,
	getRunPlanRef,
	getVerificationStatus,
	resolveRunRef,
} from "../state/run.js";
import type {
	Run,
	RunState,
	VerificationCheckDef,
	VerificationRunStartedEvent,
} from "../types/index.js";
import { matchState } from "../types/index.js";
import { outputError, outputTOON } from "../types/toon.js";
import {
	executeAllChecks,
	parseVerification,
} from "../verification/index.js";

/**
 * Get track by ref or error
 */
function getRunOrExit(ref: string): Run {
	const track = resolveRunRef(ref);
	if (!track) {
		outputError(`Run not found: ${ref}`, {
			suggestions: [
				"tiller list              # Show all runs",
				"tiller ready             # Show runs ready to work",
			],
			agent_hint: "Run tiller list to find valid plan refs or run IDs",
			exitCode: 2,
		});
	}
	return track;
}

export function registerRunCommands(program: Command): void {
	const runCmd = program
		.command("run")
		.description("Run lifecycle commands (start, pause, resume, verify, complete)");

	// ============================================
	// run start: ready → active/executing
	// Precise run creation - NOT the collapsed flow
	// ============================================
	runCmd
		.command("start <ref>")
		.description("Start a run (ready → active/executing). Precise verb, not collapsed flow.")
		.option("--initiative <name>", "Target initiative (default: current)")
		.action((ref: string, options: { initiative?: string }) => {
			const resolvedRef = options.initiative && !ref.includes(":") ? `${options.initiative}:${ref}` : ref;
			const track = getRunOrExit(resolvedRef);
			const planRef = getRunPlanRef(track);

			if (track.state !== "ready") {
				outputError(`Cannot start run: plan ${planRef} is '${track.state}', not 'ready'`, {
					suggestions: [
						`tiller start ${ref}     # Collapsed flow (proposed → active)`,
						`tiller show ${ref}      # Check current state`,
					],
					agent_hint: `Run is in '${track.state}' state. Use tiller start for collapsed flow or check state with tiller show`,
				});
			}

			// Output constitutional reminders before activation
			outputConstitutional();

			const result = applyTransition(track, "active/executing", "agent");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			outputTOON({
				run_start: {
					plan: planRef,
					from: "ready",
					to: "active/executing",
					success: true,
				},
			});

			console.log(`\n✓ Run started: ${planRef} (ready → active/executing)`);
		});

	// ============================================
	// run pause: active/executing → active/paused
	// ============================================
	runCmd
		.command("pause <ref>")
		.description("Pause an active run (active/executing → active/paused)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.action((ref: string, options: { initiative?: string }) => {
			const resolvedRef = options.initiative && !ref.includes(":") ? `${options.initiative}:${ref}` : ref;
			const track = getRunOrExit(resolvedRef);
			const planRef = getRunPlanRef(track);

			if (track.state !== "active/executing") {
				console.error(
					`Cannot pause: plan ${planRef} is '${track.state}', not 'active/executing'`,
				);
				process.exit(1);
			}

			const result = applyTransition(track, "active/paused", "agent");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			outputTOON({
				run_pause: {
					plan: planRef,
					from: "active/executing",
					to: "active/paused",
					success: true,
				},
			});

			console.log(`✓ Run paused: ${planRef}`);
		});

	// ============================================
	// run resume: active/paused → active/executing
	// ============================================
	runCmd
		.command("resume <ref>")
		.description("Resume a paused run (active/paused → active/executing)")
		.option("--initiative <name>", "Target initiative (default: current)")
		.action((ref: string, options: { initiative?: string }) => {
			const resolvedRef = options.initiative && !ref.includes(":") ? `${options.initiative}:${ref}` : ref;
			const track = getRunOrExit(resolvedRef);
			const planRef = getRunPlanRef(track);

			if (track.state !== "active/paused") {
				console.error(
					`Cannot resume: plan ${planRef} is '${track.state}', not 'active/paused'`,
				);
				process.exit(1);
			}

			const result = applyTransition(track, "active/executing", "agent");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			outputTOON({
				run_resume: {
					plan: planRef,
					from: "active/paused",
					to: "active/executing",
					success: true,
				},
			});

			console.log(`✓ Run resumed: ${planRef}`);
		});

	// ============================================
	// run verify: active/* → verifying/testing
	// Default: prose-tolerant (outputs checklist for agent)
	// --ci: YAML-required, machine-deterministic
	// Idempotent: re-runs if already verifying
	// ============================================
	runCmd
		.command("verify <ref>")
		.description(
			"Run verification (prose-tolerant by default, --ci for YAML-only deterministic)",
		)
		.option("--ci", "CI mode: require YAML format, fail on prose (deterministic)")
		.option("--dry-run", "Parse checks but don't execute")
		.option("--timeout <seconds>", "Global timeout override for checks")
		.option("--quiet", "Suppress stderr progress messages")
		.option("--json", "Output as JSON instead of TOON")
		.option("--initiative <name>", "Target initiative (default: current)")
		.action(
			async (
				ref: string,
				options: {
					ci?: boolean;
					dryRun?: boolean;
					timeout?: string;
					quiet?: boolean;
					json?: boolean;
					initiative?: string;
				},
			) => {
				const resolvedRef = options.initiative && !ref.includes(":") ? `${options.initiative}:${ref}` : ref;
				const track = getRunOrExit(resolvedRef);
				const planRef = getRunPlanRef(track);

				// Validate state: must be active/* or verifying/* (idempotent)
				const inActive = matchState(track.state, "active");
				const inVerifying = matchState(track.state, "verifying");

				if (!inActive && !inVerifying) {
					console.error(
						`Cannot verify: plan ${planRef} is '${track.state}', not active/* or verifying/*`,
					);
					process.exit(1);
				}

				// Load and parse PLAN.md
				let planContent: string;
				try {
					planContent = readPlanFile(track.plan_path);
				} catch {
					console.error(`Failed to read plan: ${track.plan_path}`);
					process.exit(1);
				}

				// Parse verification section (prose or YAML)
				const parsed = parseVerification(planContent);

				// --ci mode: require YAML format
				if (options.ci && parsed.format === "prose") {
					console.error("Error: --ci mode requires YAML-format <verification> section");
					console.error("Prose verification detected. Either:");
					console.error("  1. Convert to YAML format for deterministic CI execution");
					console.error("  2. Remove --ci flag for agent-interpreted verification");
					console.error("\nExpected YAML format:");
					console.error("  <verification>");
					console.error("  - name: check_name");
					console.error("    cmd: command --to --run");
					console.error("  </verification>");
					process.exit(1);
				}

				if (!parsed.success) {
					console.error("Failed to parse verification section:");
					parsed.errors.forEach((e: string) => console.error(`  - ${e}`));
					process.exit(1);
				}

				// Handle empty verification
				if (parsed.format === "empty") {
					console.error("No <verification> section found in PLAN.md");
					process.exit(1);
				}

				const checkDefs: VerificationCheckDef[] = parsed.checks;
				if (checkDefs.length === 0) {
					console.error("No checks defined in <verification> section");
					process.exit(1);
				}

				// Prose format: output checklist for agent interpretation (no auto-execution)
				if (parsed.format === "prose" && !options.ci) {
					const checklist = checkDefs.map((c, i) => ({
						index: i + 1,
						name: c.name,
						description: c.description,
						status: "pending",
					}));

					if (options.json) {
						console.log(JSON.stringify({ format: "prose", checks: checklist }, null, 2));
					} else {
						outputTOON(
							{
								verify_checklist: {
									plan: planRef,
									format: "prose",
									checks: checklist,
								},
							},
							{
								agent_hint:
									"Prose verification: interpret each check description and verify manually. " +
									"Use `tiller verify --pass` or `--fail` after completing verification.",
							},
						);
					}
					return;
				}

				// Apply timeout override
				const timeout = options.timeout ? parseInt(options.timeout, 10) : undefined;
				if (timeout) {
					for (const def of checkDefs) {
						if (def.cmd) def.timeout = timeout;
					}
				}

				// Dry run: show what would run
				if (options.dryRun) {
					console.log(`Found ${checkDefs.length} verification check(s):\n`);
					for (const def of checkDefs) {
						const kind = def.manual ? "(manual)" : def.cmd;
						console.log(`  ${def.manual ? "○" : "●"} ${def.name}: ${kind}`);
					}
					console.log("\n(dry run - checks not executed)");
					return;
				}

				// Transition to verifying/testing if coming from active/*
				if (inActive) {
					const transition = applyTransition(
						track,
						"verifying/testing" as RunState,
						"agent",
					);
					if (!transition.success) {
						console.error(`Failed to transition: ${transition.error}`);
						process.exit(1);
					}
				}

				// Append run_started event (idempotent - appends new run)
				const cmdCheckNames = checkDefs.filter((c) => c.cmd).map((c) => c.name);
				const startEvent: VerificationRunStartedEvent = {
					type: "run_started",
					at: new Date().toISOString(),
					by: "agent",
					checks_planned: cmdCheckNames,
				};
				appendVerificationEvent(track, startEvent);

				// Execute cmd checks
				const cmdCheckDefs = checkDefs.filter((c) => c.cmd);

				if (!options.quiet) {
					const manualCount = checkDefs.filter((c) => c.manual).length;
					console.error(
						`Running ${cmdCheckDefs.length} cmd check(s) (${manualCount} manual)...`,
					);
				}

				const events = await executeAllChecks(cmdCheckDefs, (name, i, total) => {
					if (!options.quiet) {
						console.error(`  [${i}/${total}] ${name}`);
					}
				});

				// Append check_executed events
				for (const event of events) {
					appendVerificationEvent(track, event);
				}

				// Derive snapshot and compute overall status
				const snapshot = deriveVerificationSnapshot(track, checkDefs);
				const overallStatus = getVerificationStatus(snapshot);

				// Transition based on result (engine determines outcome)
				let targetState: RunState | null = null;

				if (overallStatus === "fail") {
					targetState = "verifying/failed";
				} else if (overallStatus === "pass") {
					targetState = "verifying/passed";
				}
				// "pending" (manual checks remain) → stay in verifying/testing

				if (targetState && track.state !== targetState) {
					const transition = applyTransition(track, targetState, "agent");
					if (!transition.success) {
						console.error(`Warning: failed to transition: ${transition.error}`);
					}
				}

				// Log event
				logEvent({
					event: "verification_run",
					track: track.id,
					status: overallStatus,
					checks_passed: snapshot.checks.filter((c) => c.status === "pass").length,
					checks_total: snapshot.checks.length,
				});

				// Output result
				const result = {
					verification: {
						plan: planRef,
						state: track.state,
						checks: snapshot.checks.map((c) => ({
							name: c.name,
							kind: c.kind,
							status: c.status,
							...(c.exit_code !== undefined && { exit_code: c.exit_code }),
						})),
						manual_pending: snapshot.manual_pending,
						overall: overallStatus,
						next:
							overallStatus === "pass"
								? "tiller run complete"
								: overallStatus === "fail"
									? "tiller fix"
									: snapshot.checks
											.filter((c) => c.kind === "manual" && c.status === "pending")
											.map((c) => `tiller check record ${c.name} --pass`),
					},
				};

				if (options.json) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					outputTOON(result);
				}

				// Exit code based on cmd check failures
				const hasCmdFailure = snapshot.checks.some(
					(c) => c.kind === "cmd" && (c.status === "fail" || c.status === "error"),
				);
				if (hasCmdFailure) {
					process.exit(1);
				}
			},
		);

	// ============================================
	// run complete: verifying/passed → complete
	// Requires verification to have passed
	// ============================================
	runCmd
		.command("complete <ref>")
		.description("Complete a run (verifying/passed → complete). Requires passed verification.")
		.option("--initiative <name>", "Target initiative (default: current)")
		.action((ref: string, options: { initiative?: string }) => {
			const resolvedRef = options.initiative && !ref.includes(":") ? `${options.initiative}:${ref}` : ref;
			const track = getRunOrExit(resolvedRef);
			const planRef = getRunPlanRef(track);

			if (track.state !== "verifying/passed") {
				if (matchState(track.state, "verifying")) {
					console.error(
						`Cannot complete: plan ${planRef} is '${track.state}', not 'verifying/passed'`,
					);
					console.error("\nVerification must pass before completion.");
					console.error("Options:");
					console.error(`  - Run verification: tiller run verify ${ref}`);
					console.error(
						`  - Force (escape hatch): tiller transition ${ref} verifying/passed --force`,
					);
				} else {
					console.error(
						`Cannot complete: plan ${planRef} is '${track.state}', not in verifying state`,
					);
				}
				process.exit(1);
			}

			// Check require-summary setting
			const requireSummary = getRequireSummary();
			const summaryPath = track.plan_path.replace(/-PLAN\.md$/, "-SUMMARY.md");
			const summaryExists = existsSync(summaryPath);

			if (requireSummary === true && !summaryExists) {
				console.error(
					`Cannot complete: SUMMARY.md required (require-summary: true)`,
				);
				console.error(`Expected: ${summaryPath}`);
				console.error(
					`\nCreate SUMMARY.md or set 'require-summary: false' in PRIME.md`,
				);
				process.exit(1);
			}

			if (requireSummary === null && !summaryExists) {
				// Setting not configured - output TOON for decision
				outputTOON({
					run_complete_blocked: {
						plan: planRef,
						reason: "require-summary not set",
						summary_path: summaryPath,
						options: [
							"Create SUMMARY.md",
							"Set 'require-summary: false' in PRIME.md",
							"Set 'require-summary: true' in PRIME.md (enforces SUMMARY.md)",
						],
					},
				});
				process.exit(1);
			}

			const result = applyTransition(track, "complete", "agent");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			outputTOON({
				run_complete: {
					plan: planRef,
					from: "verifying/passed",
					to: "complete",
					success: true,
				},
			});

			console.log(`\n✓ Run complete: ${planRef}`);
		});
}
