/**
 * Verification result recording
 *
 * Handles state transitions and event sourcing for verification results.
 * Extracted from commands/verify.ts for testability.
 */

import { execSync } from "node:child_process";
import { logEvent } from "../state/events.js";
import { readPlanFile } from "../state/paths.js";
import {
	appendVerificationEvent,
	applyTransition,
	deriveVerificationSnapshot,
	getRunPlanRef,
	getVerificationStatus,
	saveRun,
} from "../state/run.js";
import type { Run, RunState, VerificationCheckDef } from "../types/index.js";
import { matchState } from "../types/index.js";
import { parseVerification } from "./parser.js";
import { finalizeSummary, findSummaryPath } from "./summary.js";
import { updatePlanCheckboxes } from "./updater.js";

/** Options for recording pass verification */
export interface RecordPassOptions {
	/** Allow --pass to skip pending manual checks */
	skipManualVerification?: boolean;
}

/** Result when verification pass is recorded successfully */
export interface RecordPassResult {
	/** Discriminator - always true for success */
	success: true;
	/** Plan reference (e.g., "06.6-01") */
	planRef: string;
	/** Current state after operation */
	state: RunState;
	/** True if run was already in complete state (idempotent success) */
	alreadyComplete?: boolean;
	/** True if run was already in verifying/passed state (idempotent success) */
	alreadyPassed?: boolean;
	/** Path to finalized SUMMARY.done.md (if SUMMARY.md was finalized) */
	summaryFinalizedTo?: string;
	/** True if manual checks were skipped via --skip-manual-verification */
	manualChecksSkipped?: boolean;
}

/** Error when manual checks are pending */
export interface ManualChecksPendingError {
	/** Discriminator - always false for errors */
	success: false;
	/** Human-readable error message */
	error: string;
	/** Flag indicating manual checks are pending */
	manualChecksPending: true;
	/** List of pending check names */
	pendingChecks?: string[];
}

/** Result when verification fail is recorded successfully */
export interface RecordFailResult {
	/** Discriminator - always true for success */
	success: true;
	/** Plan reference (e.g., "06.6-01") */
	planRef: string;
	/** Current state after operation */
	state: RunState;
	/** Generated issue ID (e.g., "UAT-001") */
	issueId: string;
}

/** Error result for recording operations */
export interface RecordError {
	/** Discriminator - always false for errors */
	success: false;
	/** Human-readable error message */
	error: string;
}

/**
 * Record verification as passed
 *
 * State-agnostic: accepts active/* or verifying/* and auto-transitions.
 * This follows Postel's Law: be liberal in what you accept.
 *
 * @param run - The run to record pass for
 * @param options - Optional settings for pass recording
 * @returns Success result with state info, or error if transition fails
 */
export function recordPassVerification(
	run: Run,
	options?: RecordPassOptions,
): RecordPassResult | RecordError | ManualChecksPendingError {
	const planRef = getRunPlanRef(run);

	// Idempotent: already complete is success
	if (run.state === "complete") {
		return { success: true, planRef, state: run.state, alreadyComplete: true };
	}

	// Idempotent: already verifying/passed is success
	// BUT: check for inconsistent state - if manual checks pending, this is invalid
	if (run.state === "verifying/passed") {
		// R4/R5: Verify done-state invariant - manual checks must be done/skipped
		const manualCheckResult = checkPendingManualChecks(run, options?.skipManualVerification);
		if (manualCheckResult.hasPending && !manualCheckResult.skipped) {
			// Inconsistent state: verifying/passed but manual checks pending
			return {
				success: false,
				error: "Inconsistent state: verifying/passed but manual checks pending. " +
					"Use --skip-manual-verification to acknowledge or complete manual checks first.",
				manualChecksPending: true,
				pendingChecks: manualCheckResult.pendingChecks,
			};
		}
		const existingSummary = findSummaryPath(run);
		if (existingSummary) {
			const finalizeResult = finalizeSummary(run, { toAutopass: manualCheckResult.skipped });
			const summaryFinalizedTo = finalizeResult.success ? finalizeResult.toPath : undefined;
			return {
				success: true,
				planRef,
				state: run.state,
				alreadyPassed: true,
				summaryFinalizedTo,
				manualChecksSkipped: manualCheckResult.skipped,
			};
		}
		return { success: true, planRef, state: run.state, alreadyPassed: true };
	}

	// State-agnostic: accept active/* or verifying/*
	const inActive = matchState(run.state, "active");
	const inVerifying = matchState(run.state, "verifying");

	if (!inActive && !inVerifying) {
		return {
			success: false,
			error: `Cannot record pass in state: ${run.state}. Valid states: active/*, verifying/*`,
		};
	}

	// Check for pending verification (manual and cmd checks)
	const verifyResult = checkPendingVerification(run, options?.skipManualVerification);

	// Gate on pending manual checks (require explicit skip)
	if (verifyResult.hasPendingManual && !verifyResult.skipped) {
		return {
			success: false,
			error: "Manual checks pending. Use --skip-manual-verification to override.",
			manualChecksPending: true,
			pendingChecks: verifyResult.pendingManualChecks,
		};
	}

	// Warn about pending cmd checks (human assertion)
	// We allow --pass to proceed but the human is asserting they passed manually
	const cmdChecksAsserted = verifyResult.hasPendingCmd;
	if (cmdChecksAsserted) {
		console.error(
			`⚠ Cmd checks not executed (human assertion): ${verifyResult.pendingCmdChecks.join(", ")}`,
		);
	}

	const manualChecksSkipped = verifyResult.skipped;

	// If in active/*, first transition to verifying/testing (FSM requirement)
	if (inActive) {
		const toTesting = applyTransition(
			run,
			"verifying/testing" as RunState,
			"human",
		);
		if (!toTesting.success) {
			return {
				success: false,
				error: `Failed to transition to testing: ${toTesting.error}`,
			};
		}
	}

	// Now transition to verifying/passed
	const transition = applyTransition(
		run,
		"verifying/passed" as RunState,
		"human",
	);
	if (!transition.success) {
		return {
			success: false,
			error: `Failed to transition: ${transition.error}`,
		};
	}

	// Record UAT result
	if (!run.verification) {
		run.verification = {};
	}
	const existingChecks = run.verification.uat?.checks || [];
	run.verification.uat = {
		status: "pass",
		checks: existingChecks,
		ran_at: new Date().toISOString(),
		issues_logged: existingChecks.filter((c) => c.status === "fail").length,
	};
	saveRun(run);

	logEvent({
		event: "verification_passed",
		track: run.id,
		cmd_checks_asserted: cmdChecksAsserted,
	});

	// Update PLAN.md checkboxes to reflect pass assertion
	// This ensures the file reflects what was verified (even if just asserted)
	if (verifyResult.parsedChecks.length > 0) {
		try {
			const checksAsPassed = verifyResult.parsedChecks.map((c) => ({
				name: c.description || c.name,
				kind: (c.cmd ? "cmd" : "manual") as "cmd" | "manual",
				status: "pass" as const,
			}));
			updatePlanCheckboxes(run.plan_path, checksAsPassed);
		} catch (err) {
			// Non-fatal: checkbox update failure doesn't block verification
			console.error(`Warning: failed to update PLAN.md checkboxes: ${err}`);
		}
	}

	// Auto-generate SUMMARY.md if missing
	const existingSummary = findSummaryPath(run);
	if (!existingSummary) {
		try {
			execSync(`tiller summary generate ${run.id}`, { stdio: "inherit" });
		} catch {
			// Non-fatal: summary generation may fail but verification can still complete
		}
	}

	// Finalize SUMMARY.md → SUMMARY.done.md (or autopass if manual checks skipped)
	const finalizeResult = finalizeSummary(run, { toAutopass: manualChecksSkipped });
	const summaryFinalizedTo = finalizeResult.success ? finalizeResult.toPath : undefined;

	return { success: true, planRef, state: run.state, summaryFinalizedTo, manualChecksSkipped };
}

/**
 * Record verification as failed
 *
 * State-agnostic: accepts active/* or verifying/* and auto-transitions.
 * This follows Postel's Law: be liberal in what you accept.
 *
 * @param run - The run to record failure for
 * @param issueDescription - Description of what failed
 * @returns Success result with issue ID, or error if transition fails
 */
export function recordFailVerification(
	run: Run,
	issueDescription: string,
): RecordFailResult | RecordError {
	const planRef = getRunPlanRef(run);

	// State-agnostic: accept active/* or verifying/*
	const inActive = matchState(run.state, "active");
	const inVerifying = matchState(run.state, "verifying");

	if (!inActive && !inVerifying) {
		return {
			success: false,
			error: `Cannot record fail in state: ${run.state}. Valid states: active/*, verifying/*`,
		};
	}

	// If in active/*, first transition to verifying/testing (FSM requirement)
	if (inActive) {
		const toTesting = applyTransition(
			run,
			"verifying/testing" as RunState,
			"human",
		);
		if (!toTesting.success) {
			return {
				success: false,
				error: `Failed to transition to testing: ${toTesting.error}`,
			};
		}
	}

	// Transition to verifying/failed
	const transition = applyTransition(
		run,
		"verifying/failed" as RunState,
		"human",
	);
	if (!transition.success) {
		return {
			success: false,
			error: `Failed to transition: ${transition.error}`,
		};
	}

	// Record UAT result with the issue
	if (!run.verification) {
		run.verification = {};
	}
	const existingChecks = run.verification.uat?.checks || [];
	const failedCount = existingChecks.filter((c) => c.status === "fail").length;
	const issueId = `UAT-${String(failedCount + 1).padStart(3, "0")}`;
	const now = new Date().toISOString();

	// Add the new issue as a failed check
	existingChecks.push({
		name: issueId,
		command: "manual-uat",
		status: "fail",
		output: issueDescription,
		ran_at: now,
	});

	run.verification.uat = {
		status: "fail",
		checks: existingChecks,
		ran_at: now,
		issues_logged: failedCount + 1,
	};
	saveRun(run);

	logEvent({
		event: "verification_failed",
		track: run.id,
		issue: issueDescription,
	});

	return { success: true, planRef, state: run.state, issueId };
}

/**
 * Skip UAT and mark as passed
 *
 * Transitions through verifying/testing to verifying/passed, skipping
 * the actual verification checks.
 *
 * @param run - The run to skip verification for
 * @returns Success result with state info, or error if transition fails
 */
export function skipVerification(run: Run): RecordPassResult | RecordError {
	const planRef = getRunPlanRef(run);

	// Transition to verifying/passed
	const targetState: RunState = "verifying/passed";

	if (matchState(run.state, "active")) {
		// First transition to verifying/testing, then to passed
		const intermediate = applyTransition(
			run,
			"verifying/testing" as RunState,
			"human",
		);
		if (!intermediate.success) {
			return {
				success: false,
				error: `Failed intermediate transition to verifying/testing: ${intermediate.error}`,
			};
		}
	}

	const transition = applyTransition(run, targetState, "human");
	if (!transition.success) {
		return {
			success: false,
			error: `Failed to transition: ${transition.error}`,
		};
	}

	logEvent({
		event: "verification_skipped",
		track: run.id,
	});

	return { success: true, planRef, state: run.state };
}

export interface RecordManualCheckOptions {
	checkName: string;
	pass: boolean;
	fail: boolean;
	reason?: string;
	by?: "agent" | "human";
	noAutoPass?: boolean;
}

export interface ManualCheckResult {
	success: true;
	planRef: string;
	checkName: string;
	status: "pass" | "fail";
	by: "agent" | "human";
	snapshot: {
		checks: Array<{ name: string; kind: string; status: string }>;
		manual_pending: boolean;
		overall: string;
	};
	state: RunState;
	next: string;
}

/**
 * Record result for a manual check (event-sourced)
 *
 * Appends a manual_recorded event to the run's verification history
 * and auto-transitions state based on overall verification status.
 *
 * Usage: tiller verify <ref> --record <name> --pass|--fail [--reason "..."]
 *
 * @param run - The run to record the manual check for
 * @param options - Check recording options (name, pass/fail, reason, etc.)
 * @returns Success result with snapshot and next action, or error if invalid
 */
export function recordManualCheckResult(
	run: Run,
	options: RecordManualCheckOptions,
): ManualCheckResult | RecordError {
	const planRef = getRunPlanRef(run);
	const { checkName, pass, fail, reason, by = "agent", noAutoPass } = options;

	// Require pass or fail
	if (!pass && !fail) {
		return {
			success: false,
			error: `--record requires --pass or --fail. Usage: tiller verify ${planRef} --record ${checkName} --pass`,
		};
	}

	// Validate state - must be in verifying/* to record manual check
	if (!matchState(run.state, "verifying")) {
		if (matchState(run.state, "active")) {
			return {
				success: false,
				error:
					"Cannot record manual check: not in verifying state. Run `tiller verify --auto` first to start verification.",
			};
		}
		return {
			success: false,
			error: `Cannot record manual check in state: ${run.state}`,
		};
	}

	// Load PLAN.md to validate check exists and is manual
	let planContent: string;
	try {
		planContent = readPlanFile(run.plan_path);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			error: `Failed to read plan ${run.plan_path}: ${message}`,
		};
	}

	// Parse verification section
	const parsed = parseVerification(planContent);
	if (!parsed.success) {
		return {
			success: false,
			error: `Failed to parse verification section: ${parsed.errors.join(", ")}`,
		};
	}

	// --record requires structured checks with names (YAML or checkbox format)
	// Prose format generates generic names like "check_001" which aren't useful for --record
	if (parsed.format === "prose") {
		return {
			success: false,
			error:
				"Error: --record requires YAML or checkbox format <verification> section in PLAN.md",
		};
	}

	const checkDefs = parsed.checks;

	// Find the check by name
	const checkDef = checkDefs.find((c) => c.name === checkName);
	if (!checkDef) {
		const validNames = checkDefs.map((c) => c.name).join(", ");
		return {
			success: false,
			error: `Unknown check '${checkName}'. Valid: ${validNames}`,
		};
	}

	// Validate it's a manual check
	if (!checkDef.manual) {
		return {
			success: false,
			error: `Cannot record '${checkName}': not a manual check. Only checks with 'manual: true' can be recorded.`,
		};
	}

	// Append the manual_recorded event
	const status = pass ? "pass" : "fail";
	const actor = by === "human" ? "human" : "agent";

	appendVerificationEvent(run, {
		type: "manual_recorded",
		name: checkName,
		status,
		reason,
		at: new Date().toISOString(),
		by: actor,
	});

	// Derive snapshot to check overall status
	const snapshot = deriveVerificationSnapshot(run, checkDefs);
	const overallStatus = getVerificationStatus(snapshot);

	// Transition based on result
	let targetState: RunState | null = null;

	if (overallStatus === "fail") {
		targetState = "verifying/failed";
	} else if (overallStatus === "pass" && !noAutoPass) {
		targetState = "verifying/passed";
	}
	// Otherwise stay in verifying/testing

	if (targetState && run.state !== targetState) {
		const transition = applyTransition(run, targetState, actor);
		if (!transition.success) {
			// Non-fatal: The manual check was recorded via event sourcing.
			// Log warning but continue - caller can observe discrepancy via run.state vs snapshot.overall.
			console.error(
				`Warning: State transition to ${targetState} failed: ${transition.error}`,
			);
		}
	}

	const next =
		overallStatus === "pass"
			? "tiller complete"
			: overallStatus === "fail"
				? "tiller fix"
				: "Continue manual checks";

	return {
		success: true,
		planRef,
		checkName,
		status,
		by: actor,
		snapshot: {
			checks: snapshot.checks.map((c) => ({
				name: c.name,
				kind: c.kind,
				status: c.status,
			})),
			manual_pending: snapshot.manual_pending,
			overall: overallStatus,
		},
		state: run.state,
		next,
	};
}

/** Result of pending verification check */
interface PendingVerificationResult {
	/** True if any manual checks are pending */
	hasPendingManual: boolean;
	/** True if any cmd checks are pending (not executed) */
	hasPendingCmd: boolean;
	/** True if pending checks were skipped via flag */
	skipped: boolean;
	/** Names of pending manual checks */
	pendingManualChecks: string[];
	/** Names of pending cmd checks */
	pendingCmdChecks: string[];
	/** Parsed check definitions (for later use) */
	parsedChecks: VerificationCheckDef[];
}

/**
 * Check if a run has pending verification checks (manual or cmd).
 *
 * Reads the PLAN.md and derives verification snapshot to check
 * if any checks are still pending. Supports all formats:
 * - YAML: explicit cmd/manual
 * - Checkbox: backticks = cmd, else manual
 * - Prose: all manual (agent-interpreted)
 *
 * @param run - The run to check
 * @param skipVerification - If true, skip is allowed and flagged
 * @returns Object with pending status for both manual and cmd checks
 */
function checkPendingVerification(
	run: Run,
	skipVerification?: boolean,
): PendingVerificationResult {
	const emptyResult: PendingVerificationResult = {
		hasPendingManual: false,
		hasPendingCmd: false,
		skipped: false,
		pendingManualChecks: [],
		pendingCmdChecks: [],
		parsedChecks: [],
	};

	// Load PLAN.md to get check definitions
	let planContent: string;
	try {
		planContent = readPlanFile(run.plan_path);
		if (process.env.TILLER_DEBUG) {
			console.error(`[DEBUG] checkPendingVerification: read plan ${run.plan_path}, length=${planContent.length}`);
		}
	} catch (err) {
		// If we can't read the plan, assume no checks
		if (process.env.TILLER_DEBUG) {
			console.error(`[DEBUG] checkPendingVerification: failed to read plan ${run.plan_path}: ${err}`);
		}
		return emptyResult;
	}

	// Parse verification section (all formats now supported)
	const parsed = parseVerification(planContent);
	if (process.env.TILLER_DEBUG) {
		console.error(`[DEBUG] checkPendingVerification: parsed format=${parsed.format}, checks=${parsed.checks.length}`);
	}
	if (!parsed.success || parsed.checks.length === 0) {
		return emptyResult;
	}

	// Derive snapshot to get current verification status
	const snapshot = deriveVerificationSnapshot(run, parsed.checks);

	// Find pending manual checks
	const pendingManualChecks = snapshot.checks
		.filter((c) => c.kind === "manual" && c.status === "pending")
		.map((c) => c.name);

	// Find pending cmd checks (not executed)
	const pendingCmdChecks = snapshot.checks
		.filter((c) => c.kind === "cmd" && c.status === "pending")
		.map((c) => c.name);

	const hasPendingManual = pendingManualChecks.length > 0;
	const hasPendingCmd = pendingCmdChecks.length > 0;
	const hasPending = hasPendingManual || hasPendingCmd;

	// Check if skip is allowed
	if (skipVerification && hasPending) {
		return {
			hasPendingManual,
			hasPendingCmd,
			skipped: true,
			pendingManualChecks,
			pendingCmdChecks,
			parsedChecks: parsed.checks,
		};
	}

	return {
		hasPendingManual,
		hasPendingCmd,
		skipped: false,
		pendingManualChecks,
		pendingCmdChecks,
		parsedChecks: parsed.checks,
	};
}

/**
 * Legacy wrapper for backward compatibility.
 * @deprecated Use checkPendingVerification instead
 */
function checkPendingManualChecks(
	run: Run,
	skipManualVerification?: boolean,
): {
	hasPending: boolean;
	skipped: boolean;
	pendingChecks: string[];
} {
	const result = checkPendingVerification(run, skipManualVerification);
	return {
		hasPending: result.hasPendingManual,
		skipped: result.skipped,
		pendingChecks: result.pendingManualChecks,
	};
}
