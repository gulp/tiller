/**
 * Tiller lifecycle commands - State transitions for tracks
 *
 * HSM State machine (slash notation):
 *   proposed → approved → ready → active/executing → verifying/testing → complete
 *
 * Active substates: executing, paused, checkpoint
 * Verifying substates: testing, passed, failed, fixing, retesting
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { fixPlanLint, formatLintTOON, lintPlan } from "../lint/plan.js";
import { planExists, readPlanFile } from "../state/paths.js";
import { getConfirmMode, getRequireSummary } from "../state/config.js";
import { outputConstitutional } from "../state/constitutional.js";
import { logEvent } from "../state/events.js";
import {
	createHandoff,
	createMinimalContext,
	deleteHandoff,
	getHandoffPath,
} from "../state/handoff.js";
import { updateRoadmapProgress } from "../state/roadmap-writer.js";
import { updateStateAuthoritative } from "../state/state-writer.js";
import { getWorkingInitiative, resolvePhasesDir } from "../state/initiative.js";
import {
	applyTransition,
	createRun,
	getDefaultRun,
	getRunPlanRef,
	listRuns,
	resolveRunRef,
	saveRun,
} from "../state/run.js";
import type { Run, RunState } from "../types/index.js";
import { matchState, VALID_TRANSITIONS } from "../types/index.js";
import { parseInitiativeRef } from "../utils/ref.js";
import {
	createConfirmation,
	formatConfirmationTOON,
	outputTOON,
} from "../types/toon.js";
import { findAutopassSummaryPath, findFinalizedSummaryPath, findSummaryPath, finalizeSummary } from "../verification/summary.js";

/**
 * Resolve plan ref (e.g., "06.6-03") to path
 * Searches: plans/{initiative}/{phase}/ per ADR-0005
 */
function resolvePlanRefToPath(ref: string): string | null {
	// If it's already a path that exists, return it
	if (existsSync(ref)) {
		return ref;
	}

	// Support initiative:ref syntax (e.g., "dogfooding:01-17")
	const parsed = parseInitiativeRef(ref);
	const effectiveRef = parsed.ref;
	const explicitInit = parsed.initiative;

	// Pattern: XX.X-YY or XX-YY
	const refMatch = effectiveRef.match(/^(\d+(?:\.\d+)?)-(\d+)$/);
	if (!refMatch) {
		return null;
	}

	const [, phase, _plan] = refMatch;
	const planFileName = `${effectiveRef}-PLAN.md`;

	// Search in plans/ directory (ADR-0005 structure)
	const searchDirs: string[] = [];

	// If explicit initiative provided, only search that directory
	if (explicitInit && existsSync(join("plans", explicitInit))) {
		searchDirs.push(join("plans", explicitInit));
	} else if (existsSync("plans")) {
		// Add plans/*/  (initiative directories)
		try {
			const initDirs = readdirSync("plans", { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => join("plans", d.name));
			searchDirs.push(...initDirs);
		} catch {
			// Ignore errors
		}
	}

	// Search for matching phase directory and plan file
	// Also check for .skip.md suffix (abandoned plans)
	const planFileNames = [planFileName, planFileName.replace(/\.md$/, ".skip.md")];

	for (const initDir of searchDirs) {
		if (!existsSync(initDir)) continue;

		try {
			const phaseDirs = readdirSync(initDir, { withFileTypes: true }).filter(
				(d) => d.isDirectory() && d.name.startsWith(`${phase}-`),
			);

			for (const phaseDir of phaseDirs) {
				for (const fileName of planFileNames) {
					const planPath = join(initDir, phaseDir.name, fileName);
					if (existsSync(planPath)) {
						return planPath;
					}
				}
			}
		} catch {
			// Ignore errors
		}
	}

	return null;
}

/**
 * Determine if confirmation TOON should be returned
 *
 * Priority:
 * 1. --confirm flag: return TOON (confirm === true)
 * 2. --no-confirm flag: execute (confirm === false via Commander negation)
 * 3. PRIME.md confirm-mode: check project setting
 * 4. Default: execute (no confirmation)
 *
 * Note: Commander.js handles --no-* by setting the option to false,
 * so --no-confirm sets confirm=false, not noConfirm=true.
 */
function shouldConfirm(options: { confirm?: boolean }): boolean {
	if (options.confirm === true) return true;
	if (options.confirm === false) return false; // --no-confirm
	return getConfirmMode(); // undefined = check PRIME.md
}

export function registerLifecycleCommands(program: Command): void {
	// Helper to get run (by plan ref, run ID, or find default)
	// 01-10: Auto-vivifies run for drafted plans in current initiative
	// Accepts optional explicit initiative to override working initiative
	async function getRun(ref?: string, initiative?: string): Promise<Run> {
		if (ref) {
			let track = resolveRunRef(ref);

			// 01-10: Auto-vivify - if no run exists, check if plan FILE exists
			if (!track) {
				const phasesDir = resolvePhasesDir(initiative);
				const phaseMatch = ref.match(/^(\d+(?:\.\d+)?)-/);

				if (phaseMatch && phasesDir) {
					const phaseId = phaseMatch[1];
					// Find phase directory
					const phaseDirs = readdirSync(phasesDir, { withFileTypes: true });
					const phaseDir = phaseDirs.find(
						(d) => d.isDirectory() && (d.name === phaseId || d.name.startsWith(`${phaseId}-`))
					);

					if (phaseDir) {
						const planPath = join(phasesDir, phaseDir.name, `${ref}-PLAN.md`);
						if (existsSync(planPath)) {
							// Extract objective from plan file
							const content = readFileSync(planPath, "utf-8");
							const objMatch = content.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/);
							const objective = objMatch?.[1]?.trim() || `Plan ${ref}`;

							// Auto-create run in ready state
							track = createRun(planPath, objective, "ready");
							const targetInit = initiative ?? getWorkingInitiative();
							if (targetInit && track.initiative !== targetInit) {
								track.initiative = targetInit;
								saveRun(track);
							}
							console.log(`✓ Created run for drafted plan: ${ref}`);
						}
					}
				}
			}

			if (!track) {
				console.error(`Run not found: ${ref}`);
				console.error(
					`Hint: Use plan ref (e.g., '02-01') or run ID (e.g., 'run-abc123')`,
				);
				process.exit(2);
			}
			return track;
		}
		const def = getDefaultRun();
		if (!def) {
			console.error("No run found. Specify plan ref or run ID.");
			process.exit(2);
		}
		return def;
	}

	// ============================================
	// transition: Pure state mutation primitive
	// Hard constraint: NO side effects beyond state change
	// ============================================
	program
		.command("transition <ref> [state]")
		.description(
			"Direct state transition primitive. Validates against HSM and logs transition.",
		)
		.option(
			"--by <actor>",
			'Who triggered: "agent" (default) or "human"',
			"agent",
		)
		.option("--reason <reason>", "Reason for transition (logged)")
		.option("--valid", "Show valid target states for this run (no transition)")
		.option(
			"--force",
			"Force invalid transition (escape hatch - logs loud warning)",
		)
		.option("--initiative <name>", "Target initiative (default: current)")
		.action(
			(
				ref: string,
				targetState: string | undefined,
				options: { by?: string; reason?: string; valid?: boolean; force?: boolean; initiative?: string },
			) => {
				const resolvedRef = options.initiative && !ref.includes(":") ? `${options.initiative}:${ref}` : ref;
				const track = resolveRunRef(resolvedRef);
				if (!track) {
					console.error(`Run not found: ${ref}`);
					console.error(
						`Hint: Use plan ref (e.g., '02-01') or run ID (e.g., 'run-abc123')`,
					);
					process.exit(2);
				}

				const planRef = getRunPlanRef(track);
				const fromState = track.state;

				// --valid: Show valid target states (for completion/discovery)
				if (options.valid) {
					const valid = VALID_TRANSITIONS[fromState] ?? [];
					outputTOON({
						valid_transitions: {
							plan: planRef,
							current_state: fromState,
							valid_targets:
								valid.length === 0 ? ["(none - terminal state)"] : valid,
						},
					});
					return;
				}

				// Require state argument for actual transition
				if (!targetState) {
					console.error("Error: Missing <state> argument");
					console.error(`Usage: tiller transition ${ref} <state>`);
					console.error(`   Or: tiller transition ${ref} --valid`);
					process.exit(1);
				}

				const toState = targetState as RunState;
				const by = options.by === "human" ? "human" : "agent";

				// Validate and apply transition
				const result = applyTransition(track, toState, by, options.reason);

				if (!result.success) {
					// --force: bypass validation (escape hatch)
					if (options.force) {
						// Log loud warning
						console.error("═".repeat(60));
						console.error("⚠  FORCED TRANSITION - ESCAPE HATCH USED");
						console.error("═".repeat(60));
						console.error(`Plan: ${planRef}`);
						console.error(`Transition: ${fromState} → ${toState}`);
						console.error(`Validation error: ${result.error}`);
						console.error("═".repeat(60));

						// Force the transition directly
						const now = new Date().toISOString();
						track.transitions.push({
							from: fromState,
							to: toState,
							at: now,
							by,
							reason: options.reason
								? `[FORCED] ${options.reason}`
								: "[FORCED] Escape hatch used",
						});
						track.state = toState;
						track.updated = now;
						saveRun(track);

						// Log the forced transition event
						logEvent({
							event: "forced_transition",
							track: track.id,
							from: fromState,
							to: toState,
							reason: options.reason,
							warning: "Escape hatch used - validation bypassed",
						});

						// Output TOON with warning
						outputTOON({
							transition: {
								plan: planRef,
								from: fromState,
								to: toState,
								by,
								forced: true,
								warning: "Escape hatch used - validation bypassed",
								...(options.reason && { reason: options.reason }),
								success: true,
							},
						});
						return;
					}

					// Show valid transitions for this state
					const valid = VALID_TRANSITIONS[fromState] ?? [];
					console.error(`Error: ${result.error}`);
					if (valid.length > 0) {
						console.error(`\nValid transitions from '${fromState}':`);
						valid.forEach((s) => console.error(`  → ${s}`));
					}
					console.error(
						`\nEscape hatch: tiller transition ${ref} ${toState} --force`,
					);
					process.exit(1);
				}

				// Output TOON with transition result
				outputTOON({
					transition: {
						plan: planRef,
						from: fromState,
						to: toState,
						by,
						...(options.reason && { reason: options.reason }),
						success: true,
					},
				});
			},
		);

	// ============================================
	// approve: proposed → approved
	// ============================================
	program
		.command("approve [ref]")
		.description(
			"Approve run for import (proposed → approved). Accepts plan ref or run ID.",
		)
		.option("--confirm", "Return TOON for human confirmation")
		.option(
			"--no-confirm",
			"Skip confirmation even if confirm-mode is set in PRIME.md",
		)
		.action(async (ref: string | undefined, options: { confirm?: boolean }) => {
			const track = await getRun(ref);
			const planRef = getRunPlanRef(track);

			if (track.state !== "proposed") {
				console.error(
					`Cannot approve: track is '${track.state}', not 'proposed'`,
				);
				process.exit(1);
			}

			// Check if confirmation should be shown (--confirm, PRIME.md, or default)
			if (shouldConfirm(options)) {
				const toon = createConfirmation(
					"approve",
					planRef,
					track.intent,
					`Approve plan ${planRef} for import?`,
				);
				console.log(formatConfirmationTOON(toon));
				return;
			}

			// Default: just do it (agent-first)
			const result = applyTransition(track, "approved", "human");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			console.log(`✓ Plan ${planRef} approved`);
			console.log(
				`Next: tiller start ${planRef}  (collapsed: approve → active)`,
			);
			console.log(
				`  Or: tiller import ${planRef} → tiller activate ${planRef}`,
			);
		});

	// ============================================
	// import: approved → ready (creates BD issues)
	// Note: Full import logic is in init.ts for now
	// This is a placeholder for manual import workflow
	// ============================================
	program
		.command("import [ref]")
		.description("[Deprecated] Use `tiller start` instead. (approved → ready)")
		.action(async (ref?: string) => {
			// Deprecation warning
			console.log("⚠ `tiller import` is deprecated");
			console.log(
				"  Use `tiller start <ref>` for collapsed workflow (proposed → active)",
			);
			console.log("");

			const track = await getRun(ref);

			if (track.state !== "approved") {
				console.error(
					`Cannot import: track is '${track.state}', not 'approved'`,
				);
				process.exit(1);
			}

			// Still do the transition for backwards compatibility
			const result = applyTransition(track, "ready", "agent");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			const planRef = getRunPlanRef(track);
			console.log(`✓ Plan ${planRef} marked ready`);
			console.log(`Next: tiller activate ${planRef}`);
		});

	// ============================================
	// activate: ready → active/executing
	// ============================================
	program
		.command("activate [ref]")
		.description(
			"Begin execution (ready → active/executing). Accepts plan ref or run ID.",
		)
		.option("--initiative <name>", "Target initiative (default: current)")
		.action(async (ref?: string, options?: { initiative?: string }) => {
			// Output constitutional reminders first (agent sees these before activation)
			outputConstitutional();

			const track = await getRun(ref, options?.initiative);

			if (track.state !== "ready") {
				console.error(
					`Cannot activate: track is '${track.state}', not 'ready'`,
				);
				process.exit(1);
			}

			const result = applyTransition(track, "active/executing", "human");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			const planRef = getRunPlanRef(track);
			console.log(`✓ Plan ${planRef} activated (ready → active/executing)`);

			// Hint next step based on plan state
			if (track.plan_path && planExists(track.plan_path)) {
				const content = readPlanFile(track.plan_path);
				const hasExpandMarker =
					(content.includes("<!-- TODO:") && content.includes("<!-- END TODO -->")) ||
					(content.includes("<!-- EXPAND:") && content.includes("<!-- END EXPAND -->"));

				if (hasExpandMarker) {
					console.log(`\nNext: tiller plan expand ${planRef}`);
				} else {
					console.log(`\nNext: Read ${track.plan_path} and execute tasks`);
				}
			}

			if (track.beads_task_id) {
				console.log(
					`Execution: bd ready --parent=${track.beads_epic_id || track.beads_task_id}`,
				);
			}
		});

	// ============================================
	// NOTE: verify command moved to commands/verify.ts (runs automated checks)
	// ============================================

	// ============================================
	// complete: verifying/passed → complete
	// [Deprecated] Use 'tiller run complete' for strict verification flow
	// ============================================
	program
		.command("complete [ref]")
		.description(
			"Mark plan complete (requires passed verification or --skip-verify)",
		)
		.option("--skip-verify", "Complete without requiring verification")
		.option("--force", "Complete from any state (proposed, active, etc.)")
		.option(
			"--skip-uat",
			"Skip UAT check (still requires automated verification)",
		)
		.option("--skip-summary", "Skip SUMMARY.md existence check")
		.option("--dry-run", "Show what would happen without making changes")
		.option("--reason <text>", "Reason for completion (audit trail)")
		.option("--confirm", "Return TOON for human confirmation")
		.option(
			"--no-confirm",
			"Skip confirmation even if confirm-mode is set in PRIME.md",
		)
		.option(
			"--auto",
			"Auto-generate summary and verify in one command (no manual steps)",
		)
		.action(
			async (
				ref?: string,
				options?: {
					skipVerify?: boolean;
					force?: boolean;
					skipUat?: boolean;
					skipSummary?: boolean;
					dryRun?: boolean;
					reason?: string;
					confirm?: boolean;
					auto?: boolean;
				},
			) => {
				const track = await getRun(ref);
				const planRef = getRunPlanRef(track);
				const skipVerify = options?.skipVerify || options?.force;

				// State-specific completion logic per HSM state machine
				if (track.state === "verifying/passed") {
					// Happy path: verification passed, can complete
				} else if (matchState(track.state, "verifying")) {
					// In verification but not passed - check state and flags
					if (track.state === "verifying/failed") {
						if (options?.skipUat) {
							console.log(
								`Note: completing with --skip-uat from '${track.state}' (UAT issues ignored)`,
							);
						} else if (skipVerify) {
							console.log(
								`Warning: forcing completion from '${track.state}' (skipping verification)`,
							);
						} else {
							// Output TOON error (ADR-0003: TOON by default)
							outputTOON({
								error: {
									plan: planRef,
									state: track.state,
									reason: "Verification failed",
									next: [
										`tiller fix ${planRef}`,
										`tiller verify ${planRef} --auto`,
										`tiller complete ${planRef} --skip-verify`,
									],
								},
							});
							process.exit(1);
						}
					} else if (track.state === "verifying/fixing") {
						if (skipVerify) {
							console.log(
								`Warning: forcing completion from '${track.state}' (fix in progress)`,
							);
						} else {
							outputTOON({
								error: {
									plan: planRef,
									state: track.state,
									reason: "Fix in progress",
									next: [
										"Complete the fix tasks",
										`tiller verify ${planRef} --auto`,
									],
								},
							});
							process.exit(1);
						}
					} else if (track.state === "verifying/retesting") {
						if (skipVerify) {
							console.log(
								`Warning: forcing completion from '${track.state}' (re-verification pending)`,
							);
						} else {
							outputTOON({
								error: {
									plan: planRef,
									state: track.state,
									reason: "Re-verification in progress",
									next: [`tiller verify ${planRef} --auto`],
								},
							});
							process.exit(1);
						}
					} else if (track.state === "verifying/testing") {
						if (skipVerify) {
							console.log(
								`Warning: forcing completion from '${track.state}' (verification pending)`,
							);
						} else {
							// Check for manual checks pending
							const hasPendingManual =
								track.verification?.events?.some(
									(e) => e.type === "run_started",
								) &&
								!track.verification?.events?.some(
									(e) =>
										e.type === "manual_recorded" ||
										(e.type === "check_executed" && e.status !== "pass"),
								);

							outputTOON({
								error: {
									plan: planRef,
									state: track.state,
									reason: "Verification in progress",
									next: hasPendingManual
										? [`tiller verify ${planRef} --record <name> --pass`]
										: [`tiller verify ${planRef} --pass`],
								},
							});
							process.exit(1);
						}
					}
				} else if (matchState(track.state, "active")) {
					// Completing from active/* - warn and require --skip-verify or --auto
					if (skipVerify) {
						console.log(
							`Warning: completing from '${track.state}' without verification`,
						);
					} else if (options?.auto) {
						// --auto: Run verify --pass to transition to verifying/passed
						console.log(`Running verification...`);
						try {
							execSync(`tiller verify ${track.id} --pass`, {
								stdio: "inherit",
							});
							// Reload track to get updated state
							const updatedTrack = await getRun(track.id);
							if (updatedTrack.state !== "verifying/passed") {
								console.error(`Verification did not reach passed state: ${updatedTrack.state}`);
								process.exit(1);
							}
							track.state = updatedTrack.state;
						} catch {
							console.error(`Verification failed`);
							process.exit(1);
						}
					} else {
						outputTOON({
							error: {
								plan: planRef,
								state: track.state,
								reason: "Verification not started",
								next: [
									`tiller verify ${planRef} --auto`,
									`tiller complete ${planRef} --skip-verify`,
									`tiller complete ${planRef} --auto`,
								],
							},
						});
						process.exit(1);
					}
				} else {
					// Invalid state for completion - unless --force
					if (options?.force) {
						console.log(`Warning: forcing completion from '${track.state}'`);
					} else {
						outputTOON({
							error: {
								plan: planRef,
								state: track.state,
								reason: "Invalid state for completion",
								valid_states: ["verifying/passed", "active/*"],
								next: [`tiller complete ${planRef} --force`],
							},
						});
						process.exit(1);
					}
				}

				// Check for finalized summary (done or autopass) - unless --skip-summary or --skip-verify/--force
				// Uses summary.ts utilities to find all summary states correctly:
				//   .done.md = fully finalized, .autopass.md = auto-checks passed, .md = draft
				// Priority: flag > PRIME.md config > TOON for agent decision
				let summaryFinalizedPath = findFinalizedSummaryPath(track);
				const summaryAutopassPath = findAutopassSummaryPath(track);
				const summaryAnyPath = findSummaryPath(track);
				let summaryFinalized = !!summaryFinalizedPath || !!summaryAutopassPath;
				const summaryDraftExists = !!summaryAnyPath && !summaryFinalized;

				// --auto: Handle full summary lifecycle in one command
				if (options?.auto && !summaryFinalized) {
					// Step 1: Generate SUMMARY.md if no summary exists at all
					if (!summaryAnyPath) {
						console.log(`Auto-generating SUMMARY.md...`);
						try {
							execSync(`tiller summary generate ${track.id}`, {
								stdio: "inherit",
							});
							// Verify something was created
							const newPath = findSummaryPath(track);
							if (!newPath) {
								console.error(`Failed to generate SUMMARY.md`);
								process.exit(1);
							}
							console.log(`✓ SUMMARY.md generated`);
						} catch {
							console.error(`Failed to auto-generate SUMMARY.md`);
							process.exit(1);
						}
					}

					// Step 2: Finalize summary → SUMMARY.done.md
					console.log(`Finalizing summary...`);
					const finalizeResult = finalizeSummary(track);
					if (!finalizeResult.success) {
						console.error(`Failed to finalize: ${finalizeResult.error}`);
						process.exit(1);
					}
					console.log(`Summary finalized: ${finalizeResult.toPath}`);
					summaryFinalized = true;
					summaryFinalizedPath = finalizeResult.toPath ?? null;
					// Continue to completion below
				}

				// Validate finalized summary has title field (if it exists and not skipping)
				// Auto-fix missing frontmatter if content exists (agent-first: accept direct writes)
				const actualFinalizedPath = summaryFinalizedPath || summaryAutopassPath;
				if (actualFinalizedPath && !options?.skipSummary && !skipVerify) {
					let summaryContent = readFileSync(actualFinalizedPath, "utf-8");
					const titleMatch = summaryContent.match(/^title:\s*(.+)$/m);
					if (!titleMatch || !titleMatch[1].trim()) {
						// Extract title from first H1 or use plan intent
						const h1Match = summaryContent.match(/^#\s+(.+)$/m);
						const autoTitle = h1Match?.[1]?.replace(/^Summary:\s*/i, "").trim() || track.intent;
						// Prepend frontmatter
						const frontmatter = `---\ntitle: "${autoTitle}"\n---\n\n`;
						summaryContent = frontmatter + summaryContent;
						writeFileSync(actualFinalizedPath, summaryContent);
						console.log(`Auto-added frontmatter to summary (title: "${autoTitle}")`);
					}
				}

				if (!summaryFinalized && !options?.skipSummary && !skipVerify) {
					const requireSummary = getRequireSummary();

					if (requireSummary === true) {
						// Finalized summary required but doesn't exist
						if (summaryDraftExists) {
							// Draft exists but not finalized
							// If already in verifying/passed, finalize automatically
							if (track.state === "verifying/passed") {
								console.log(`Finalizing summary...`);
								const finalizeResult = finalizeSummary(track);
								if (!finalizeResult.success) {
									console.error(`Failed to finalize: ${finalizeResult.error}`);
									process.exit(1);
								}
								console.log(`✓ Summary finalized: ${finalizeResult.toPath}`);
								summaryFinalized = true;
							} else {
								// Not verified yet - need to verify first
								console.error(`SUMMARY.md exists but not verified.`);
								console.error(`Run: tiller verify ${planRef} --pass`);
								console.error(`     (This will finalize SUMMARY.md → SUMMARY.done.md)`);
								process.exit(1);
							}
						} else {
							// No summary at all - auto-generate draft
							console.log(`Auto-generating SUMMARY.md...`);
							try {
								execSync(`tiller summary generate ${track.id}`, {
									stdio: "inherit",
								});
								// Verify it was created
								const newPath = findSummaryPath(track);
								if (!newPath) {
									console.error(`Failed to generate SUMMARY.md`);
									process.exit(1);
								}
								console.log(`✓ SUMMARY.md generated`);

								// If already in verifying/passed, finalize immediately
								if (track.state === "verifying/passed") {
									console.log(`Finalizing summary...`);
									const finalizeResult = finalizeSummary(track);
									if (!finalizeResult.success) {
										console.error(`Failed to finalize: ${finalizeResult.error}`);
										process.exit(1);
									}
									console.log(`✓ Summary finalized: ${finalizeResult.toPath}`);
									summaryFinalized = true;
								} else {
									// Need verification first
									console.error(`Now verify: tiller verify ${planRef} --pass`);
									process.exit(1);
								}
							} catch (err) {
								console.error(`Failed to auto-generate SUMMARY.md`);
								console.error(`Manual: tiller summary generate ${planRef}`);
								process.exit(1);
							}
						}
					} else if (requireSummary === null) {
						// Not configured - return TOON for agent to decide or ask user
						const question = summaryDraftExists
							? `SUMMARY.md exists but not verified. Complete without verification?`
							: `SUMMARY.md not found. Complete without it?`;
						const options_list = summaryDraftExists
							? [
									{
										label: "Yes, skip verification",
										action: `tiller complete ${planRef} --skip-summary`,
									},
									{
										label: "No, verify first",
										action: `tiller verify ${planRef} --pass`,
									},
								]
							: [
									{
										label: "Yes, skip summary",
										action: `tiller complete ${planRef} --skip-summary`,
									},
									{
										label: "No, generate first",
										action: `tiller summary generate ${planRef}`,
									},
								];
						console.log(
							formatConfirmationTOON({
								confirmation: {
									action: "complete",
									run: planRef,
									intent: track.intent,
									question,
									risk_level: "low",
									options: options_list,
								},
							}),
						);
						return;
					}
					// requireSummary === false: skip check, continue
				}

				// Check if confirmation should be shown (--confirm, PRIME.md, or default)
				if (shouldConfirm({ confirm: options?.confirm })) {
					const toon = createConfirmation(
						"complete",
						planRef,
						track.intent,
						`Complete plan ${planRef}?`,
					);
					console.log(formatConfirmationTOON(toon));
					return;
				}

				// Build completion record before transition
				const now = new Date();
				const verificationPassed = track.state === "verifying/passed";
				const issuesResolved = track.verification?.uat?.issues_logged ?? 0;

				// Calculate duration from first active/executing transition
				let durationMinutes: number | undefined;
				const activeTransition = track.transitions.find(
					(t) => t.to === "active/executing",
				);
				if (activeTransition) {
					const startTime = new Date(activeTransition.at);
					durationMinutes = Math.round(
						(now.getTime() - startTime.getTime()) / 60000,
					);
				}

				// Dry-run: show what would happen without making changes
				if (options?.dryRun) {
					console.log(`DRY RUN: tiller complete ${planRef}\n`);
					console.log(`Current state: ${track.state}`);
					console.log(`Would transition to: complete`);
					console.log(
						`Verification: ${skipVerify ? "skipped" : verificationPassed ? "passed" : "not passed"}`,
					);
					if (durationMinutes !== undefined) {
						console.log(
							`Duration: ${durationMinutes < 60 ? `${durationMinutes} min` : `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`}`,
						);
					}
					console.log(`\nArtifacts to update:`);
					console.log(`  - Run state file`);
					console.log(
						`  - STATE.md (initiative: ${track.initiative || "legacy"})`,
					);
					console.log(`  - ROADMAP.md`);
					console.log(
						`\n✓ Validation passed. Run without --dry-run to complete.`,
					);
					return;
				}

				// Set completion record
				track.completion = {
					timestamp: now.toISOString(),
					verification: {
						passed: verificationPassed,
						skipped: !!skipVerify,
						issues_resolved: issuesResolved > 0 ? issuesResolved : undefined,
					},
					duration_minutes: durationMinutes,
					reason: options?.reason,
				};

				// Save track with completion record before transition
				saveRun(track);

				// --force: bypass state machine entirely, directly set to complete
				if (
					options?.force &&
					!matchState(track.state, "verifying") &&
					!matchState(track.state, "active")
				) {
					// Warning only - continue to SUMMARY.md checks (force bypasses state checks, not all validation)
					const originalState = track.state;
					track.state = "complete" as RunState;
					track.updated = now.toISOString();
					track.transitions.push({
						from: originalState,
						to: "complete" as RunState,
						at: now.toISOString(),
						by: "human",
					});
					saveRun(track);
				} else {
					// When skipping verification, transition through verifying/passed first
					// (HSM doesn't allow direct transitions like verifying/testing -> complete)
					if (
						skipVerify &&
						matchState(track.state, "verifying") &&
						track.state !== "verifying/passed"
					) {
						const passResult = applyTransition(
							track,
							"verifying/passed" as RunState,
							"human",
						);
						if (!passResult.success) {
							console.error(
								`Error transitioning to verifying/passed: ${passResult.error}`,
							);
							process.exit(1);
						}
					} else if (skipVerify && matchState(track.state, "active")) {
						// From active/*, transition through verifying states
						applyTransition(track, "verifying/testing" as RunState, "human");
						applyTransition(track, "verifying/passed" as RunState, "human");
					}

					const result = applyTransition(track, "complete", "human");
					if (!result.success) {
						console.error(`Error: ${result.error}`);
						process.exit(1);
					}
				}

				// Display completion summary
				console.log(`✓ Plan ${planRef} completed!\n`);

				// Verification status
				if (skipVerify) {
					console.log(`Verification: Skipped (--skip-verify)`);
				} else if (verificationPassed) {
					if (issuesResolved > 0) {
						console.log(
							`Verification: Passed (${issuesResolved} issue${issuesResolved === 1 ? "" : "s"} found and resolved)`,
						);
					} else {
						console.log(`Verification: Passed`);
					}
				}

				// Duration
				if (durationMinutes !== undefined) {
					if (durationMinutes < 60) {
						console.log(`Duration: ${durationMinutes} min`);
					} else {
						const hours = Math.floor(durationMinutes / 60);
						const mins = durationMinutes % 60;
						console.log(`Duration: ${hours}h ${mins}m`);
					}
				}

				// Update split files (STATE.md Authoritative, ROADMAP.md Progress)
				try {
					updateStateAuthoritative(track.initiative);
					updateRoadmapProgress(track.initiative);
					const initLabel = track.initiative || "legacy";
					console.log(
						`Updated STATE.md and ROADMAP.md for initiative: ${initLabel}`,
					);
				} catch (err) {
					// Non-fatal: track is complete even if file updates fail
					console.warn(`Warning: Failed to update STATE.md/ROADMAP.md: ${err}`);
				}

				// Auto-close linked bead
				if (track.beads_task_id) {
					try {
						execSync(
							`bd close ${track.beads_task_id} --reason="Run ${planRef} completed"`,
							{ stdio: "pipe" },
						);
						console.log(`Closed bead: ${track.beads_task_id}`);
					} catch (err) {
						// Non-fatal: track is complete even if bead closure fails
						console.warn(
							`Warning: Failed to close bead ${track.beads_task_id}: ${err}`,
						);
					}
				}
			},
		);

	// ============================================
	// rework: verifying/* or complete → active/executing (back to development)
	// ============================================
	program
		.command("rework [ref]")
		.description(
			"Send run back for rework (verifying/* or complete → active/executing). Accepts plan ref or run ID.",
		)
		.option("--reason <reason>", "Reason for rework (logged in transition)")
		.option("--confirm", "Return TOON for human confirmation")
		.option(
			"--no-confirm",
			"Skip confirmation even if confirm-mode is set in PRIME.md",
		)
		.action(
			async (
				ref?: string,
				options?: { reason?: string; confirm?: boolean },
			) => {
				const track = await getRun(ref);
				const planRef = getRunPlanRef(track);

				if (
					!matchState(track.state, "verifying") &&
					track.state !== "complete"
				) {
					console.error(
						`Cannot rework: plan ${planRef} is '${track.state}', not in verifying or complete`,
					);
					process.exit(1);
				}

				// Check if confirmation should be shown (--confirm, PRIME.md, or default)
				if (shouldConfirm({ confirm: options?.confirm })) {
					const toon = createConfirmation(
						"rework",
						planRef,
						track.intent,
						`Send plan ${planRef} back for rework?`,
					);
					console.log(formatConfirmationTOON(toon));
					return;
				}

				// Rework goes back to active/executing (restart development)
				const result = applyTransition(
					track,
					"active/executing" as RunState,
					"human",
					options?.reason,
				);
				if (!result.success) {
					console.error(`Error: ${result.error}`);
					process.exit(1);
				}

				console.log(
					`✓ Plan ${planRef} sent back for rework (${track.state} → active/executing)`,
				);
				if (options?.reason) {
					console.log(`  Reason: ${options.reason}`);
				}
				console.log(`\nNext: Read ${track.plan_path} and address issues`);
			},
		);

	// ============================================
	// pause: active/executing → active/paused
	// Creates .continue-here.md for session continuity
	// ============================================
	program
		.command("pause [ref]")
		.description(
			"Pause active run and create handoff context (active/executing → active/paused). Accepts plan ref or run ID.",
		)
		.option("--context <text>", "Current state/context to preserve")
		.option("--next <text>", "Suggested next action when resuming")
		.option("--no-handoff", "Skip creating .continue-here.md")
		.action(
			async (
				ref?: string,
				options?: { context?: string; next?: string; handoff?: boolean },
			) => {
				const track = await getRun(ref);
				const planRef = getRunPlanRef(track);

				if (track.state !== "active/executing") {
					console.error(
						`Cannot pause: plan ${planRef} is '${track.state}', not 'active/executing'`,
					);
					process.exit(1);
				}

				const result = applyTransition(track, "active/paused", "human");
				if (!result.success) {
					console.error(`Error: ${result.error}`);
					process.exit(1);
				}

				console.log(
					`✓ Plan ${planRef} paused (active/executing → active/paused)`,
				);

				// Create handoff file for session continuity (unless --no-handoff)
				if (options?.handoff !== false) {
					const currentState =
						options?.context ?? `Run ${planRef} paused. Review plan and continue execution.`;
					const nextAction =
						options?.next ?? `Resume with: tiller resume ${planRef}`;

					const handoffContext = createMinimalContext(currentState, nextAction);
					createHandoff(track, handoffContext);

					console.log(`\nHandoff created: ${getHandoffPath(track)}`);
					console.log(`Resume with full context: tiller prime --full`);
				}
			},
		);

	// ============================================
	// resume: active/paused → active/executing
	// Cleans up .continue-here.md after resuming
	// ============================================
	program
		.command("resume [ref]")
		.description(
			"Resume paused run (active/paused → active/executing). Accepts plan ref or run ID.",
		)
		.option("--keep-handoff", "Keep .continue-here.md after resuming")
		.action(async (ref?: string, options?: { keepHandoff?: boolean }) => {
			const track = await getRun(ref);
			const planRef = getRunPlanRef(track);

			if (track.state !== "active/paused") {
				console.error(
					`Cannot resume: plan ${planRef} is '${track.state}', not 'active/paused'`,
				);
				process.exit(1);
			}

			const result = applyTransition(track, "active/executing", "human");
			if (!result.success) {
				console.error(`Error: ${result.error}`);
				process.exit(1);
			}

			console.log(
				`✓ Plan ${planRef} resumed (active/paused → active/executing)`,
			);

			// Clean up handoff file (unless --keep-handoff)
			if (!options?.keepHandoff) {
				const deleted = deleteHandoff(track);
				if (deleted) {
					console.log(`Handoff cleaned up: ${getHandoffPath(track)}`);
				}
			}

			console.log(`\nNext: Continue executing ${track.plan_path}`);
			console.log(`When done: tiller verify ${planRef}`);
		});

	// ============================================
	// abandon: proposed|approved|ready|active/* → abandoned
	// (Not allowed from verifying/* or terminal states)
	// ============================================
	program
		.command("abandon [ref]")
		.description(
			"Abandon run (not from verifying or terminal states). Accepts plan ref or run ID.",
		)
		.option("--reason <reason>", "Reason for abandoning (logged in transition)")
		.option("--confirm", "Return TOON for human confirmation")
		.option(
			"--no-confirm",
			"Skip confirmation even if confirm-mode is set in PRIME.md",
		)
		.action(
			async (
				ref?: string,
				options?: { reason?: string; confirm?: boolean },
			) => {
				const track = await getRun(ref);
				const planRef = getRunPlanRef(track);

				// Terminal states cannot be abandoned
				if (track.state === "complete" || track.state === "abandoned") {
					console.error(
						`Cannot abandon: plan ${planRef} is already '${track.state}'`,
					);
					process.exit(1);
				}

				// Verifying states cannot be abandoned (must complete or rework)
				if (matchState(track.state, "verifying")) {
					console.error(
						`Cannot abandon: plan ${planRef} is in '${track.state}'`,
					);
					console.error(
						`Use 'tiller rework' to return to active, or 'tiller complete --force' to finish`,
					);
					process.exit(1);
				}

				// Check if confirmation should be shown (--confirm, PRIME.md, or default)
				if (shouldConfirm({ confirm: options?.confirm })) {
					const toon = createConfirmation(
						"abandon",
						planRef,
						track.intent,
						`Abandon plan ${planRef}? This cannot be undone.`,
					);
					console.log(formatConfirmationTOON(toon));
					return;
				}

				const result = applyTransition(
					track,
					"abandoned",
					"human",
					options?.reason,
				);
				if (!result.success) {
					console.error(`Error: ${result.error}`);
					process.exit(1);
				}

				// Rename PLAN.md to PLAN.skip.md to signal abandoned state in filesystem
				const planPath = track.plan_path;
				if (planPath.endsWith("-PLAN.md") && existsSync(planPath)) {
					const skipPath = planPath.replace(/-PLAN\.md$/, "-PLAN.skip.md");
					renameSync(planPath, skipPath);
					// Update run's plan_path to reflect renamed file
					track.plan_path = skipPath;
					saveRun(track);
				}

				console.log(`✓ Plan ${planRef} abandoned (${track.state} → abandoned)`);
				if (options?.reason) {
					console.log(`  Reason: ${options.reason}`);
				}
			},
		);

	// ============================================
	// lint: Check and optionally fix PLAN.md lint issues
	// ============================================
	program
		.command("lint <ref>")
		.description("Lint a PLAN.md file and optionally auto-fix issues")
		.option("--fix", "Auto-fix fixable lint issues")
		.action((ref: string, options: { fix?: boolean }) => {
			const planPath = resolvePlanRefToPath(ref);
			if (!planPath) {
				console.error(`Plan not found: ${ref}`);
				process.exit(2);
			}

			if (options.fix) {
				// Auto-fix mode
				const result = fixPlanLint(planPath);
				if (result.fixed) {
					console.log(`✓ Fixed ${result.changes.length} issue(s) in ${ref}:`);
					result.changes.forEach((c) => console.log(`  ✓ ${c}`));
					console.log(`\nRe-run: tiller start ${ref}`);
				} else {
					console.log("No auto-fixable issues found.");
				}
				return;
			}

			// Normal lint check
			const issues = lintPlan(planPath);
			if (issues.length === 0) {
				console.log(`✓ No lint issues in ${ref}`);
				return;
			}

			// Output as TOON for agent decision
			console.log(formatLintTOON(issues, planPath, ref));
		});

	// ============================================
	// start: init + approve + import + activate in one step
	// ============================================
	program
		.command("start <ref>")
		.description(
			"Initialize and activate a plan in one step (init + approve + import + activate)",
		)
		.option("--no-beads", "Skip beads import")
		.option("--confirm", "Return TOON for confirmation before starting")
		.option(
			"--no-confirm",
			"Skip confirmation even if confirm-mode is set in PRIME.md",
		)
		.option("--skip-lint", "Skip plan lint checks")
		.action(
			async (
				ref: string,
				options: { beads: boolean; confirm?: boolean; skipLint?: boolean },
			) => {
				// Resolve ref to path (searches plans/{initiative}/{phase}/)
				const planPath = resolvePlanRefToPath(ref);
				if (!planPath) {
					console.error(`Plan not found: ${ref}`);
					process.exit(2);
				}

				// Lint check (unless --skip-lint)
				if (!options.skipLint) {
					const issues = lintPlan(planPath);
					if (issues.length > 0) {
						console.log(formatLintTOON(issues, planPath, ref));
						return; // Return TOON, let agent/human decide
					}
				}

				// Check if already tracked - if so, collapse from current state
				const existingTracks = listRuns();
				let track = existingTracks.find((t) => t.plan_path === planPath);

				// --confirm: return TOON
				if (shouldConfirm({ confirm: options.confirm })) {
					const action = track
						? `Collapse ${track.state} → active/executing`
						: "Initialize and activate plan";
					console.log(
						formatConfirmationTOON({
							confirmation: {
								action: "start",
								run: ref,
								intent: action,
								question: `Start plan ${ref}?`,
								risk_level: "low",
								options: [
									{
										label: "Yes, start",
										action: `tiller start ${ref}${options.beads ? "" : " --no-beads"}`,
									},
									{ label: "No, cancel", action: null },
								],
							},
						}),
					);
					return;
				}

				const beadsFlag = options.beads ? "" : " --no-beads";

				try {
					// If not tracked, init first
					if (!track) {
						console.log(`Initializing ${planPath}...`);
						execSync(
							`bun run src/tiller/index.ts init "${planPath}"${beadsFlag}`,
							{ stdio: "inherit" },
						);

						// Get the created track
						const tracks = listRuns();
						track = tracks.find((t) => t.plan_path === planPath);
						if (!track) {
							console.error("Error: Run not created after init");
							process.exit(1);
						}
					}

					const planRef = getRunPlanRef(track);

					// Collapse to active/executing from current state
					// Skip steps that are already done
					if (track.state === "proposed") {
						console.log(`Approving ${planRef}...`);
						execSync(
							`bun run src/tiller/index.ts approve "${planRef}" --no-confirm`,
							{ stdio: "inherit" },
						);
						track = resolveRunRef(planRef)!;
					}

					if (track.state === "approved") {
						console.log(`Importing ${planRef}...`);
						execSync(`bun run src/tiller/index.ts import "${planRef}"`, {
							stdio: "inherit",
						});
						track = resolveRunRef(planRef)!;
					}

					if (track.state === "ready") {
						console.log(`Activating ${planRef}...`);
						execSync(`bun run src/tiller/index.ts activate "${planRef}"`, {
							stdio: "inherit",
						});
						track = resolveRunRef(planRef)!;
					}

					// Check final state
					if (track.state.startsWith("active")) {
						console.log(`\n✓ Plan ${planRef} started (${track.state})`);
					} else if (
						track.state.startsWith("verifying") ||
						track.state === "complete"
					) {
						console.log(`\n✓ Plan ${planRef} is already ${track.state}`);
					} else {
						console.error(
							`\n⚠ Plan ${planRef} is in unexpected state: ${track.state}`,
						);
					}
				} catch (e) {
					console.error("Error during start:", e);
					process.exit(1);
				}
			},
		);
}
