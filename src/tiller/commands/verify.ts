/**
 * Tiller verify command
 *
 * Shows UAT checklist from SUMMARY.md for interactive user acceptance testing.
 * Use --auto to run automated checks from PLAN.md instead.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { extractCheckpointTasks, extractHtmlTag } from "../markdown/parser.js";
import { readPlanFile } from "../state/paths.js";
import { getRequireSummary } from "../state/config.js";
import { logEvent } from "../state/events.js";
import {
	appendVerificationEvent,
	applyTransition,
	deriveVerificationSnapshot,
	getRunPlanRef,
	getVerificationStatus,
	saveRun,
} from "../state/run.js";
import type {
	Run,
	RunState,
	VerificationCheckDef,
	VerificationRunStartedEvent,
} from "../types/index.js";
import { matchState } from "../types/index.js";
import {
	formatCheckpointsTOON,
	formatUATChecklistTOON,
	outputError,
	outputTOON,
	type UATTest,
} from "../types/toon.js";
import {
	executeAllChecks,
	extractFilesModified,
	findSummaryPath,
	formatPhaseHealthReport,
	getOverallStatus,
	getPhaseHealthReport,
	getRunForVerify,
	hasVerificationSection,
	hasYamlVerificationSection,
	isPhaseRef,
	parseVerificationSection,
	parseVerificationSectionFull,
	parseVerification,
	recordFailVerification,
	recordManualCheckResult,
	recordPassVerification,
	runVerificationChecks,
	skipVerification,
	updatePlanCheckboxes,
} from "../verification/index.js";
import {
	extractDeliverablesAsync,
	extractEpicId,
	generateChecklist,
} from "../verification/uat.js";

/**
 * Run phase-level health check
 */
async function verifyPhase(
	phaseId: string,
	_options?: VerifyOptions,
): Promise<void> {
	const report = await getPhaseHealthReport(phaseId);
	if (!report) {
		console.error(`Phase not found: ${phaseId}`);
		process.exit(1);
	}
	console.log(formatPhaseHealthReport(report));
}

/**
 * Verify a plan without a run (plan-only mode)
 * Extracts verification criteria from PLAN.md and presents for manual verification
 */
async function verifyPlanOnly(
	planPath: string,
	planRef: string,
	options?: VerifyOptions,
): Promise<void> {
	const planContent = readFileSync(planPath, "utf-8");

	// Extract verification section with full details
	const parsedChecks = parseVerificationSectionFull(planContent);

	// MODE: Automated checks
	if (options?.auto) {
		// Filter only automated checks (those with commands)
		const autoChecks = parsedChecks.filter((c) => c.command);

		if (autoChecks.length === 0) {
			console.log(`No automated checks found in ${planPath}`);
			return;
		}

		console.log(`Running ${autoChecks.length} automated check(s) from ${planPath}...\n`);

		// Convert to check descriptions (with backticks for commands)
		const checkDescriptions = autoChecks.map((c) => `\`${c.command}\``);

		// Execute checks using runVerificationChecks
		const results = await runVerificationChecks(checkDescriptions, {
			timeout: options.timeout ? options.timeout * 1000 : undefined,
		});

		const totalChecks = results.length;
		const passedChecks = results.filter((r) => r.status === "pass").length;
		const failedChecks = results.filter((r) => r.status === "fail").length;

		console.log(`\n${passedChecks}/${totalChecks} checks passed`);

		if (failedChecks > 0) {
			process.exit(1);
		}
		return;
	}

	// MODE: Default - Show manual checklist in TOON format
	if (parsedChecks.length === 0) {
		console.log(`\`\`\`toon
plan_verification:
  plan_ref: "${planRef}"
  plan_path: "${planPath}"
  no_run: true
  checks: []
  message: "No verification criteria found in <verification> section"
\`\`\``);
		return;
	}

	// Format checks for TOON output
	const checkLines = parsedChecks.map((check) => {
		if (check.command) {
			return `    - auto: "\`${check.command}\`"`;
		}
		return `    - manual: "${check.description.replace(/"/g, '\\"')}"`;
	});

	console.log(`\`\`\`toon
plan_verification:
  plan_ref: "${planRef}"
  plan_path: "${planPath}"
  no_run: true
  checks:
${checkLines.join("\n")}
\`\`\`

agent_hint: "This plan has no run yet. Use --auto to run automated checks, or create a run with \`tiller init ${planRef}\` for full verification workflow."`);
}

interface VerifyOptions {
	auto?: boolean;
	dryRun?: boolean;
	skip?: boolean;
	json?: boolean;
	pass?: boolean;
	fail?: boolean;
	issue?: string;
	human?: boolean;
	force?: boolean;
	withCommands?: string; // JSON map of check descriptions to commands
	// New event-sourced options (08-03-PLAN)
	record?: string; // Check name to record (for manual checks)
	reason?: string; // Reason for --record --fail
	by?: "agent" | "human"; // Who recorded (default: agent)
	timeout?: number; // Global timeout override (seconds)
	noAutoPass?: boolean; // Skip auto-transition to passed
	quiet?: boolean; // Suppress stderr progress
	// GSD-style checkpoint options (06.6-24-PLAN)
	checkpoints?: boolean; // Show checkpoint tasks from <tasks> section
	// SUMMARY lifecycle options (06.6-50-PLAN)
	skipManualVerification?: boolean; // Allow --pass to skip pending manual checks
	complete?: boolean; // Auto-complete after verification passes (06.6-59-PLAN)
}

export function registerVerifyCommand(program: Command): void {
	program
		.command("verify [ref]")
		.description(
			"Run verification on a plan (state-agnostic: works from active/* or verifying/*)",
		)
		.option("--auto", "Run automated checks from PLAN.md instead of UAT")
		.option("--dry-run", "Parse checks but don't run them (with --auto)")
		.option("--skip", "Skip UAT and mark as passed")
		.option("--json", "Output checklist as JSON (or TOON without)")
		.option("--pass", "Mark verification as passed")
		.option("--fail", "Mark verification as failed")
		.option("--issue <description>", "Issue description (with --fail)")
		.option(
			"--human",
			"Return TOON checklist for human UAT via AskUserQuestion",
		)
		.option("--force", "Allow verification on completed runs (re-verify)")
		.option(
			"--with-commands <json>",
			"JSON map of check descriptions to commands (use '-' for stdin, '@file' for file)",
		)
		// New event-sourced options (08-03-PLAN)
		.option(
			"--record <name>",
			"Record result for a manual check by name (requires --pass or --fail)",
		)
		.option("--reason <reason>", "Reason for manual check result")
		.option(
			"--by <actor>",
			'Who recorded: "agent" (default) or "human"',
			"agent",
		)
		.option(
			"--timeout <seconds>",
			"Global timeout override for checks (seconds)",
		)
		.option("--no-auto-pass", "Skip auto-transition to passed")
		.option("--quiet", "Suppress stderr progress messages")
		.option(
			"--checkpoints",
			"Show GSD-style checkpoint tasks from <tasks> section",
		)
		.option(
			"--skip-manual-verification",
			"Allow --pass to complete even with pending manual checks (creates .autopass.md)",
		)
		.option(
			"--complete",
			"Mark as complete immediately after passing verification (requires --pass)",
		)
		.action(async (ref?: string, options?: VerifyOptions) => {
			// Validate --complete flag combination
			if (options?.complete) {
				if (options?.fail) {
					console.error("Error: --complete cannot be used with --fail");
					process.exit(1);
				}
				if (!options?.pass) {
					console.error("Error: --complete requires --pass");
					process.exit(1);
				}
			}

			// Check if ref is a phase ref (e.g., "06.6" vs "06.6-01")
			if (ref && isPhaseRef(ref)) {
				await verifyPhase(ref, options);
				return;
			}

			// Find run or plan
			const { run, planPath } = getRunForVerify(ref);

			// PLAN-ONLY MODE: No run exists, but PLAN.md found
			if (!run && planPath) {
				await verifyPlanOnly(planPath, ref || "unknown", options);
				return;
			}

			// Error: Neither run nor plan found
			if (!run) {
				console.error(
					"No run or plan found. Specify plan ref (e.g., '02-01') or run ID.",
				);
				process.exit(2);
			}

			// Validate state (HSM: match parent states) - --force bypasses all state checks
			if (!options?.force) {
				const validState =
					matchState(run.state, "active") ||
					matchState(run.state, "verifying");
				if (!validState) {
					const planRef = getRunPlanRef(run);
					outputError(`Run must be active or verifying (current: ${run.state})`, {
						suggestions: [
							`tiller verify ${planRef} --force   # Override state check`,
							`tiller show ${planRef}             # Check run details`,
							`tiller activate ${planRef}         # Start work on this plan`,
						],
						agent_hint: `Run is in '${run.state}' state. Either activate it first or use --force to override`,
					});
				}
			}

			// MODE: Record manual check result (--record <name> --pass|--fail)
			if (options?.record) {
				await handleRecordManualCheck(run, options);
				return;
			}

			// MODE: Record pass result (legacy - for overall verification)
			if (options?.pass) {
				await handleRecordPass(run, options);
				return;
			}

			// MODE: Record fail result (legacy - for overall verification)
			if (options?.fail) {
				await handleRecordFail(run, options.issue);
				return;
			}

			// MODE: GSD-style checkpoints (--checkpoints flag)
			if (options?.checkpoints) {
				await showCheckpointTasks(run);
				return;
			}

			// MODE: Human UAT (--human flag) - return TOON for AskUserQuestion
			if (options?.human) {
				await showHumanUATTOON(run);
				return;
			}

			// MODE: Automated checks (--auto flag)
			if (options?.auto) {
				await runAutomatedChecks(run, options);
				return;
			}

			// MODE: Skip UAT
			if (options?.skip) {
				await handleSkipUAT(run);
				return;
			}

			// MODE: Default - Show UAT checklist from SUMMARY.md
			await showUATChecklist(run, options);
		});
}

/**
 * CLI handler: Record pass result
 */
async function handleRecordPass(run: Run, options?: VerifyOptions): Promise<void> {
	const result = recordPassVerification(run, {
		skipManualVerification: options?.skipManualVerification,
	});
	if (!result.success) {
		// Check if this is a manual-checks-pending error
		if ("manualChecksPending" in result && result.manualChecksPending) {
			const planRef = getRunPlanRef(run);
			console.error("⚠ Cannot complete verification: manual checks pending\n");
			console.error("Pending manual checks:");
			for (const check of result.pendingChecks || []) {
				console.error(`  ○ ${check}`);
			}
			console.error("\nOptions:");
			console.error(`  tiller verify ${planRef} --pass --skip-manual-verification  # Skip manual checks`);
			console.error(`  tiller verify ${planRef} --record <name> --pass             # Record each manual check`);
			process.exit(1);
		}
		console.error(result.error);
		process.exit(1);
	}

	if (result.alreadyComplete) {
		console.log(`Plan ${result.planRef}: already complete`);
		return;
	}

	if (result.alreadyPassed) {
		console.log(`Plan ${result.planRef}: verification already passed`);
		console.log(`State: ${result.state}`);
		console.log("\nNext: tiller complete");
		return;
	}

	console.log(`Plan ${result.planRef}: verification passed`);
	console.log(`State: ${result.state}`);
	if (result.summaryFinalizedTo) {
		console.log(`Summary finalized: ${result.summaryFinalizedTo}`);
	}
	if (result.manualChecksSkipped) {
		console.log(`⚠ Manual checks skipped (--skip-manual-verification)`);
		console.log(`Summary state: autopass (pending manual verification)`);
	}

	// Auto-complete if --complete flag is set
	if (options?.complete) {
		console.log("\nAuto-completing plan...");
		try {
			execSync(`tiller complete ${result.planRef}`, { stdio: "inherit" });
		} catch (err) {
			console.error(`Failed to auto-complete: ${err}`);
			process.exit(1);
		}
	} else {
		console.log("\nNext: tiller complete");
	}
}

/**
 * CLI handler: Record fail result
 */
async function handleRecordFail(run: Run, issueDescription?: string): Promise<void> {
	const planRef = getRunPlanRef(run);

	if (!issueDescription) {
		console.error("Issue description required. Use --issue flag:");
		console.error(
			`  tiller verify ${planRef} --fail --issue "Description of what failed"`,
		);
		process.exit(1);
	}

	const result = recordFailVerification(run, issueDescription);
	if (!result.success) {
		console.error(result.error);
		process.exit(1);
	}

	console.log(`Plan ${result.planRef}: verification failed`);
	console.log(`State: ${result.state}`);
	console.log(`\nIssue recorded: ${result.issueId}`);
	console.log(`Description: ${issueDescription}`);
	console.log("\nNext: tiller fix");
}

/**
 * CLI handler: Skip UAT and mark as passed
 */
async function handleSkipUAT(run: Run): Promise<void> {
	const result = skipVerification(run);
	if (!result.success) {
		console.error(result.error);
		process.exit(1);
	}

	console.log(`Plan ${result.planRef}: UAT skipped, marked as passed`);
	console.log(`State: ${result.state}`);
	console.log("\nNext: tiller complete");
}

/**
 * CLI handler: Show GSD-style checkpoint tasks from PLAN.md
 *
 * Checkpoint format in PLAN.md:
 * ```markdown
 * <task type="checkpoint:human-verify">
 *   <gate>blocking</gate>
 *   <what-built>Description of what was implemented</what-built>
 *   <how-to-verify>
 *     1. Open the application
 *     2. Test the feature
 *     3. Verify expected behavior
 *   </how-to-verify>
 *   <resume-signal>Type approved or describe issues</resume-signal>
 * </task>
 * ```
 *
 * Checkpoint types:
 * - checkpoint:human-verify - User verifies implementation
 * - checkpoint:decision - User makes a decision
 * - checkpoint:human-action - User performs an action
 */
async function showCheckpointTasks(run: Run): Promise<void> {
	const planRef = getRunPlanRef(run);

	// Read PLAN.md
	let planContent: string;
	try {
		planContent = readPlanFile(run.plan_path);
	} catch {
		console.error(`Failed to read plan: ${run.plan_path}`);
		process.exit(1);
	}

	// Parse checkpoint tasks from <tasks> section
	const checkpoints = extractCheckpointTasks(planContent);

	if (checkpoints.length === 0) {
		console.log(`Plan ${planRef}: No checkpoint tasks found`);
		console.log(`\nExpected format in <tasks> section:`);
		console.log(`  <task type="checkpoint:human-verify">`);
		console.log(`    <gate>blocking</gate>`);
		console.log(`    <what-built>...</what-built>`);
		console.log(`    <how-to-verify>...</how-to-verify>`);
		console.log(`    <resume-signal>...</resume-signal>`);
		console.log(`  </task>`);
		console.log(`\nAlternatively use: tiller verify ${planRef} --human`);
		return;
	}

	// Output TOON for agent to present via AskUserQuestion
	console.log(formatCheckpointsTOON(planRef, run.plan_path, checkpoints));
}

/**
 * CLI handler: Record manual check result
 */
async function handleRecordManualCheck(run: Run, options: VerifyOptions): Promise<void> {
	const result = recordManualCheckResult(run, {
		checkName: options.record!,
		pass: options.pass ?? false,
		fail: options.fail ?? false,
		reason: options.reason,
		by: options.by as "agent" | "human",
		noAutoPass: options.noAutoPass,
	});

	if (!result.success) {
		console.error(result.error);
		process.exit(1);
	}

	// Output TOON with updated snapshot
	outputTOON({
		verification: {
			plan: result.planRef,
			recorded: {
				name: result.checkName,
				status: result.status,
				by: result.by,
				...(options.reason && { reason: options.reason }),
			},
			snapshot: result.snapshot,
			state: result.state,
			next: result.next,
		},
	});
}

/**
 * Show human UAT as TOON for AskUserQuestion handoff
 */
async function showHumanUATTOON(run: Run): Promise<void> {
	const planRef = getRunPlanRef(run);

	// Try to get tests from SUMMARY.md first, then PLAN.md
	const summaryPath = findSummaryPath(run);
	let tests: UATTest[] = [];

	if (summaryPath) {
		const summaryContent = readFileSync(summaryPath, "utf-8");
		const epicId = extractEpicId(summaryContent);
		const deliverables = await extractDeliverablesAsync(summaryContent, epicId);
		const checks = generateChecklist(deliverables);

		tests = checks.map((c) => ({
			name: c.feature,
			description: c.description,
			steps: [`Verify: ${c.feature}`],
			expected: "Feature works as described",
		}));
	} else {
		// Fall back to PLAN.md verification section
		const planContent = readPlanFile(run.plan_path);
		const verifyChecks = parseVerificationSection(planContent);

		tests = verifyChecks.map((check, i) => ({
			name: `Check ${i + 1}`,
			description: check,
			steps: [check],
			expected: "Check passes",
		}));
	}

	if (tests.length === 0) {
		tests = [
			{
				name: "Manual verification",
				description: "Verify the implementation works as expected",
				steps: ["Review the changes", "Test the functionality"],
				expected: "All features work correctly",
			},
		];
	}

	console.log(
		formatUATChecklistTOON({
			uat_checklist: {
				run: planRef,
				plan_path: run.plan_path,
				intent: run.intent,
				tests,
				options: [
					{ label: "All passed", action: `tiller verify ${planRef} --pass` },
					{
						label: "Issues found",
						action: `tiller verify ${planRef} --fail --issue "..."`,
					},
					{ label: "Skip for now", action: null },
				],
			},
		}),
	);
}

/**
 * Show UAT checklist from SUMMARY.md
 */
async function showUATChecklist(
	run: Run,
	options?: VerifyOptions,
): Promise<void> {
	// Transition to verifying/testing if was active/*
	if (matchState(run.state, "active")) {
		const transition = applyTransition(
			run,
			"verifying/testing" as RunState,
			"agent",
		);
		if (!transition.success) {
			console.error(`Failed to transition: ${transition.error}`);
			process.exit(1);
		}
	}

	const planRef = getRunPlanRef(run);

	// Find SUMMARY.md
	const summaryPath = findSummaryPath(run);
	if (!summaryPath) {
		console.error(`No SUMMARY.md found for plan ${planRef}`);
		console.error(`Expected near: ${run.plan_path}`);
		console.error(
			"\nCreate SUMMARY.md first, or use --auto for automated checks from PLAN.md",
		);
		process.exit(1);
	}

	// Read SUMMARY.md and extract deliverables
	const summaryContent = readFileSync(summaryPath, "utf-8");
	const epicId = extractEpicId(summaryContent);
	const deliverables = await extractDeliverablesAsync(summaryContent, epicId);

	if (deliverables.length === 0) {
		console.error("No testable deliverables found in SUMMARY.md");
		console.error(`Path: ${summaryPath}`);
		process.exit(1);
	}

	// Generate checklist
	const checks = generateChecklist(deliverables);

	logEvent({
		event: "verification_started",
		track: run.id,
		checks_count: checks.length,
	});

	// JSON output mode
	if (options?.json) {
		console.log(
			JSON.stringify(
				{
					plan_ref: planRef,
					run_id: run.id,
					state: run.state,
					summary_path: summaryPath,
					checks: checks.map((c) => ({
						id: c.id,
						feature: c.feature,
						description: c.description,
					})),
				},
				null,
				2,
			),
		);
		return;
	}

	// Markdown output (default)
	console.log(`Plan: ${planRef}`);
	console.log(`State: ${run.state}`);
	console.log("");
	console.log("## UAT Checklist");
	console.log("");
	console.log(`Based on: ${summaryPath}`);
	console.log("");
	console.log("### Features to Test");
	console.log("");

	for (const check of checks) {
		console.log(`${check.id}. [ ] ${check.feature}`);
	}

	console.log("");
	console.log("### Instructions");
	console.log("");
	console.log("Test each feature manually. Then run:");
	console.log(`  tiller verify ${planRef} --pass    # All tests passed`);
	console.log(
		`  tiller verify ${planRef} --fail    # Issues found (prompts for details)`,
	);
}

/**
 * Output TOON for agent to generate commands for manual checks
 */
function outputAgentAssistTOON(
	run: Run,
	manualChecks: string[],
	planContent: string,
): void {
	const planRef = getRunPlanRef(run);

	// Extract context from plan
	const objective = extractHtmlTag(planContent, "objective")?.trim() || "";
	const filesModified = extractFilesModified(planContent);

	outputTOON({
		verify_assist: {
			plan: planRef,
			path: run.plan_path,
			objective: objective.slice(0, 200), // Truncate for context
			files_modified: filesModified,
			checks_needing_commands: manualChecks,
			task: "Generate a shell command for each check description.",
			response_format: "JSON object mapping check description to command",
			usage_examples: [
				`echo '{"check desc": "cmd"}' | tiller verify ${planRef} --auto --with-commands -`,
				`tiller verify ${planRef} --auto --with-commands @commands.json`,
			],
		},
	});
	console.log(
		`\nTask: Generate commands, then pipe JSON to: tiller verify ${planRef} --auto --with-commands -`,
	);
}


/**
 * Run event-sourced verification checks (08-03-PLAN)
 *
 * Features:
 * - Append-only event log for forensics
 * - Deterministic execution with fixed timeouts
 * - Auto-transition based on results
 * - TOON output to stdout, progress to stderr
 */
async function runEventSourcedChecks(
	run: Run,
	planContent: string,
	options?: VerifyOptions,
): Promise<void> {
	const planRef = getRunPlanRef(run);

	// Parse YAML verification section
	const parsed = parseVerification(planContent);
	if (!parsed.success) {
		console.error("Failed to parse verification section:");
		parsed.errors.forEach((e: string) => console.error(`  - ${e}`));
		process.exit(1);
	}

	const checkDefs = parsed.checks;
	if (checkDefs.length === 0) {
		console.error("No checks defined in <verification> section");
		console.error(`Plan path: ${run.plan_path}`);
		process.exit(1);
	}

	// Apply global timeout override
	if (options?.timeout) {
		for (const def of checkDefs) {
			if (def.cmd) {
				def.timeout = options.timeout;
			}
		}
	}

	// Dry run: just show what would run
	if (options?.dryRun) {
		console.log(`Found ${checkDefs.length} verification check(s):\n`);
		for (const def of checkDefs) {
			const kind = def.manual ? "(manual)" : def.cmd;
			console.log(`  ○ ${def.name}: ${kind}`);
		}
		console.log("\n(dry run - checks not executed)");
		return;
	}

	// Transition to verifying/testing if was active/*
	if (matchState(run.state, "active")) {
		const transition = applyTransition(
			run,
			"verifying/testing" as RunState,
			"agent",
		);
		if (!transition.success) {
			console.error(`Failed to transition: ${transition.error}`);
			process.exit(1);
		}
	}

	// Append run_started event
	const cmdCheckNames = checkDefs.filter((c: VerificationCheckDef) => c.cmd).map((c: VerificationCheckDef) => c.name);
	const startEvent: VerificationRunStartedEvent = {
		type: "run_started",
		at: new Date().toISOString(),
		by: "agent",
		checks_planned: cmdCheckNames,
	};
	appendVerificationEvent(run, startEvent);

	// Execute cmd checks sequentially
	const cmdCheckDefs = checkDefs.filter((c: VerificationCheckDef) => c.cmd);

	if (!options?.quiet) {
		console.error(
			`Running ${cmdCheckDefs.length} cmd check(s) (${checkDefs.filter((c: VerificationCheckDef) => c.manual).length} manual)...`,
		);
	}

	const events = await executeAllChecks(cmdCheckDefs, (name, i, total) => {
		if (!options?.quiet) {
			console.error(`  [${i}/${total}] ${name}`);
		}
	});

	// Append all check_executed events
	for (const event of events) {
		appendVerificationEvent(run, event);
	}

	// Derive snapshot and compute overall status
	const snapshot = deriveVerificationSnapshot(run, checkDefs);
	const overallStatus = getVerificationStatus(snapshot);

	// Update PLAN.md checkboxes with results
	try {
		updatePlanCheckboxes(run.plan_path, snapshot.checks);
	} catch (err) {
		// Non-fatal: checkbox update failure doesn't block verification
		console.error(`Warning: failed to update PLAN.md checkboxes: ${err}`);
	}

	// Determine state transition
	let targetState: RunState | null = null;

	if (overallStatus === "fail") {
		// Any fail|error → verifying/failed
		targetState = "verifying/failed";
	} else if (overallStatus === "pass" && !options?.noAutoPass) {
		// All pass → verifying/passed (auto-transition)
		targetState = "verifying/passed";
	} else if (snapshot.manual_pending) {
		// Cmd pass but manual pending → stay verifying/testing
		targetState = null;
	}

	if (targetState && run.state !== targetState) {
		const transition = applyTransition(run, targetState, "agent");
		if (!transition.success) {
			console.error(`Warning: failed to transition: ${transition.error}`);
		}
	}

	// Log verification run
	logEvent({
		event: "verification_run",
		track: run.id,
		status: overallStatus,
		checks_passed: snapshot.checks.filter((c) => c.status === "pass").length,
		checks_total: snapshot.checks.length,
	});

	// Output TOON or JSON
	if (options?.json) {
		console.log(
			JSON.stringify(
				{
					plan: planRef,
					state: run.state,
					snapshot: {
						checks: snapshot.checks,
						manual_pending: snapshot.manual_pending,
					},
					overall: overallStatus,
					next:
						overallStatus === "pass"
							? "tiller complete"
							: overallStatus === "fail"
								? "tiller fix"
								: "Record manual checks",
				},
				null,
				2,
			),
		);
	} else {
		outputTOON({
			verification: {
				plan: planRef,
				state: run.state,
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
						? "tiller complete"
						: overallStatus === "fail"
							? "tiller fix"
							: snapshot.manual_pending
								? snapshot.checks
										.filter((c) => c.kind === "manual" && c.status === "pending")
										.map(
											(c) =>
												`tiller verify ${planRef} --record ${c.name} --pass`,
										)
								: "Continue",
			},
		});
	}

	// Exit code based on cmd check results only (manual pending is ok)
	const hasCmdFailure = snapshot.checks.some(
		(c) => c.kind === "cmd" && (c.status === "fail" || c.status === "error"),
	);
	if (hasCmdFailure) {
		process.exit(1);
	}
}

/**
 * Run automated checks from PLAN.md
 *
 * Supports two formats:
 * 1. YAML format (08-03-PLAN) - event-sourced with deterministic execution
 * 2. Legacy markdown format - for backward compatibility
 */
async function runAutomatedChecks(
	run: Run,
	options?: VerifyOptions,
): Promise<void> {
	// Load PLAN.md
	let planContent: string;
	try {
		planContent = readPlanFile(run.plan_path);
	} catch {
		console.error(`Failed to read plan: ${run.plan_path}`);
		process.exit(1);
	}

	// Detect format: YAML or legacy markdown
	if (hasYamlVerificationSection(planContent)) {
		// New YAML format with event-sourcing
		await runEventSourcedChecks(run, planContent, options);
		return;
	}

	// Legacy markdown format (original behavior)
	// Parse verification section with full detail
	const parsedChecks = parseVerificationSectionFull(planContent);
	if (parsedChecks.length === 0) {
		if (!hasVerificationSection(planContent)) {
			console.error("No <verification> section found in PLAN.md");
		} else {
			console.error(
				"<verification> section found but contains no checklist items",
			);
			console.error(
				"Expected format: - [ ] `command` description  OR  - `command` description",
			);
		}
		console.error(`Plan path: ${run.plan_path}`);
		process.exit(1);
	}

	// If --with-commands provided, merge agent-generated commands
	let agentCommands: Record<string, string> = {};
	if (options?.withCommands) {
		let jsonInput = options.withCommands;
		try {
			// Support stdin with '-' and file with '@path'
			if (jsonInput === "-") {
				jsonInput = readFileSync(0, "utf-8").trim();
			} else if (jsonInput.startsWith("@")) {
				const filePath = jsonInput.slice(1);
				if (!existsSync(filePath)) {
					console.error(`File not found: ${filePath}`);
					process.exit(1);
				}
				jsonInput = readFileSync(filePath, "utf-8").trim();
			}
			agentCommands = JSON.parse(jsonInput);
		} catch (e) {
			console.error(
				`Invalid JSON in --with-commands: ${e instanceof Error ? e.message : e}`,
			);
			process.exit(1);
		}
	}

	// Apply agent-generated commands to checks that don't have them
	const checksWithCommands: string[] = [];
	const manualChecks: string[] = [];

	for (const check of parsedChecks) {
		if (check.command) {
			// Already has command from backticks
			checksWithCommands.push(check.description);
		} else if (agentCommands[check.description]) {
			// Agent provided command - prepend it with backticks
			checksWithCommands.push(
				`\`${agentCommands[check.description]}\` ${check.description}`,
			);
		} else {
			// No command - needs agent assistance
			manualChecks.push(check.description);
		}
	}

	// If NO automated checks and there are manual checks, output TOON for agent
	if (checksWithCommands.length === 0 && manualChecks.length > 0 && !options?.withCommands) {
		outputAgentAssistTOON(run, manualChecks, planContent);
		return;
	}

	if (!options?.quiet) {
		console.error(`Found ${checksWithCommands.length} verification check(s):`);
	}

	if (options?.dryRun) {
		for (const check of checksWithCommands) {
			console.log(`  ○ ${check}`);
		}
		console.log("\n(dry run - checks not executed)");
		return;
	}

	// Run automated checks first (legacy path)
	if (!options?.quiet) {
		console.error("Running checks...\n");
	}
	const results = await runVerificationChecks(checksWithCommands);

	// Update PLAN.md checkboxes with results (legacy format)
	try {
		// Convert VerificationCheck[] to DerivedCheck[] for updater
		const derivedChecks = results.map((r) => ({
			name: r.name,
			kind: r.command === "(manual)" ? ("manual" as const) : ("cmd" as const),
			status:
				r.status === "skip"
					? ("pending" as const)
					: (r.status as "pass" | "fail"),
		}));
		updatePlanCheckboxes(run.plan_path, derivedChecks);
	} catch (err) {
		console.error(`Warning: failed to update PLAN.md checkboxes: ${err}`);
	}

	// Display results
	for (const result of results) {
		const icon =
			result.status === "pass" ? "✓" : result.status === "skip" ? "○" : "✗";
		console.log(`  ${icon} ${result.name}`);
		if (result.status === "fail" && result.output) {
			// Show first line of output for failures
			const firstLine = result.output.split("\n")[0];
			console.log(`    → ${firstLine}`);
		}
	}

	// Completion gate checks (when using --force to validate against current config)
	if (options?.force) {
		console.log("\nCompletion gates:");

		const requireSummary = getRequireSummary();
		if (requireSummary === true) {
			const summaryPath = findSummaryPath(run);
			if (summaryPath) {
				console.log("  ✓ SUMMARY.md exists");
			} else {
				console.log("  ✗ SUMMARY.md missing (require-summary: true)");
				results.push({
					name: "SUMMARY.md exists",
					command: "completion-gate",
					status: "fail",
					output: "SUMMARY.md required but not found",
					ran_at: new Date().toISOString(),
				});
			}
		} else if (requireSummary === false) {
			console.log("  ○ SUMMARY.md not required (require-summary: false)");
		} else {
			const summaryPath = findSummaryPath(run);
			console.log(
				summaryPath
					? "  ✓ SUMMARY.md exists"
					: "  ○ SUMMARY.md missing (not required)",
			);
		}
	}

	// Calculate overall status after all checks (including completion gates)
	const overallStatus = getOverallStatus(results);

	// Update run verification results
	const now = new Date().toISOString();
	if (!run.verification) {
		run.verification = {};
	}
	run.verification.automated = {
		checks: results,
		status: overallStatus,
		ran_at: now,
	};

	// Transition to verifying/testing if was active/*
	if (matchState(run.state, "active")) {
		const transition = applyTransition(
			run,
			"verifying/testing" as RunState,
			"agent",
		);
		if (!transition.success) {
			console.error(`Failed to transition: ${transition.error}`);
		}
	} else {
		saveRun(run);
	}

	logEvent({
		event: "verification_run",
		track: run.id,
		status: overallStatus,
		checks_passed: results.filter((c) => c.status === "pass").length,
		checks_total: results.length,
	});

	// Summary
	const passed = results.filter((c) => c.status === "pass").length;
	console.log(`\nVerification: ${passed}/${results.length} checks passed`);
	console.log(`Run state: ${run.state}`);

	if (overallStatus === "fail") {
		console.log(
			"\n⚠ Some checks failed. Run 'tiller fix' to create a fix plan.",
		);
		process.exit(1);
	}

	// If there are remaining manual checks, notify agent
	if (manualChecks.length > 0 && !options?.withCommands) {
		console.log(`\n⚠ ${manualChecks.length} manual check(s) still need verification:`);
		for (const check of manualChecks) {
			console.log(`  ○ ${check}`);
		}
		console.log("\nProvide commands or verify manually, then run:");
		console.log(`  tiller verify ${getRunPlanRef(run)} --pass`);
	}
}
