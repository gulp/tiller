/**
 * Tiller check command group
 *
 * Two purposes under one semantic namespace ("check" = inspect/acknowledge, never mutate):
 *
 * 1. ADR-0006: Read-only invariant detection (check scan)
 *    - Runs all invariant checks
 *    - Outputs findings with level, code, ref, message
 *    - Exit code: 0 if clean, 1 if findings
 *
 * 2. ADR-0004: Manual verification acknowledgment (check record)
 *    - Records manual check result
 *    - Engine aggregates to determine verification outcome
 *
 * Commands:
 * - check scan                          Run invariant checks (ADR-0006)
 * - check record <name> --pass|--fail   Record manual check result (ADR-0004)
 * - check list [ref]                    List verification checks for a plan
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../state/config.js";
import { planExists, readPlanFile } from "../state/paths.js";
import { logEvent } from "../state/events.js";
import {
	appendVerificationEvent,
	deriveVerificationSnapshot,
	getRunPlanRef,
	getVerificationStatus,
	listRuns,
	parsePlanRef,
	resolveRunRef,
	applyTransition,
} from "../state/run.js";
import type { Run, RunState, VerificationCheckDef } from "../types/index.js";
import { matchState, VALID_TRANSITIONS } from "../types/index.js";
import { outputTOON } from "../types/toon.js";
import {
	hasVerificationSection,
	hasYamlVerificationSection,
	parseVerificationYaml,
} from "../verification/index.js";

/**
 * Get track by ref or find exactly one in verifying state.
 * Fails hard on ambiguity (0 or >1 verifying tracks).
 */
function getRunForCheck(ref?: string): { track: Run } | { error: string } {
	if (ref) {
		const track = resolveRunRef(ref);
		if (!track) {
			return { error: `Run not found: ${ref}` };
		}
		return { track };
	}

	// Find runs in verifying state - require exactly one
	const allRuns = listRuns();
	const verifying = allRuns.filter((t) => matchState(t.state, "verifying"));

	if (verifying.length === 0) {
		return { error: "No runs in verifying state. Specify plan ref explicitly." };
	}

	if (verifying.length > 1) {
		const refs = verifying.map((t) => getRunPlanRef(t)).join(", ");
		return {
			error: `Ambiguous: ${verifying.length} runs in verifying state (${refs}). Specify plan ref explicitly.`,
		};
	}

	return { track: verifying[0] };
}

// ============================================
// Finding type for invariant checks (ADR-0006)
// ============================================
type FindingLevel = "error" | "warning" | "info";

interface Finding {
	level: FindingLevel;
	code: string;
	ref: string;
	message: string;
}

// ============================================
// Invariant check implementations
// ============================================

/**
 * Check for duplicate phase numbers
 */
function checkPhaseCollisions(phasesDir: string): Finding[] {
	const findings: Finding[] = [];
	if (!existsSync(phasesDir)) return findings;

	const phaseDirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	// Extract phase numbers (e.g., "06.6-tiller-ax-friction" → "06.6")
	const phaseNumbers = new Map<string, string[]>();
	for (const dir of phaseDirs) {
		const match = dir.match(/^(\d+(?:\.\d+)?)-/);
		if (match) {
			const num = match[1];
			const existing = phaseNumbers.get(num) ?? [];
			existing.push(dir);
			phaseNumbers.set(num, existing);
		}
	}

	// Find duplicates
	for (const [num, dirs] of phaseNumbers) {
		if (dirs.length > 1) {
			findings.push({
				level: "error",
				code: "PHASE_COLLISION",
				ref: num,
				message: `Duplicate phase number: ${dirs.join(", ")}`,
			});
		}
	}

	return findings;
}

/**
 * Check for duplicate plan refs within phases
 */
function checkPlanCollisions(phasesDir: string): Finding[] {
	const findings: Finding[] = [];
	if (!existsSync(phasesDir)) return findings;

	const planRefs = new Map<string, string[]>();

	const phaseDirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory());

	for (const phaseDir of phaseDirs) {
		const phaseFullPath = join(phasesDir, phaseDir.name);
		const planFiles = readdirSync(phaseFullPath)
			.filter((f) => f.endsWith("-PLAN.md"));

		for (const planFile of planFiles) {
			const ref = planFile.replace("-PLAN.md", "");
			const fullPath = join(phaseFullPath, planFile);
			const existing = planRefs.get(ref) ?? [];
			existing.push(fullPath);
			planRefs.set(ref, existing);
		}
	}

	// Find duplicates
	for (const [ref, paths] of planRefs) {
		if (paths.length > 1) {
			findings.push({
				level: "error",
				code: "PLAN_COLLISION",
				ref,
				message: `Duplicate plan ref in: ${paths.map((p) => dirname(p)).join(", ")}`,
			});
		}
	}

	return findings;
}

/**
 * Check for orphan plans (plan file not matching phase directory)
 */
function checkOrphanPlans(phasesDir: string): Finding[] {
	const findings: Finding[] = [];
	if (!existsSync(phasesDir)) return findings;

	const phaseDirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory());

	for (const phaseDir of phaseDirs) {
		const phaseMatch = phaseDir.name.match(/^(\d+(?:\.\d+)?)-/);
		if (!phaseMatch) continue;
		const phaseNum = phaseMatch[1];

		const phaseFullPath = join(phasesDir, phaseDir.name);
		const planFiles = readdirSync(phaseFullPath)
			.filter((f) => f.endsWith("-PLAN.md"));

		for (const planFile of planFiles) {
			const ref = planFile.replace("-PLAN.md", "");
			// Plan ref should start with phase number (e.g., "06.6-01" in phase "06.6-...")
			if (!ref.startsWith(phaseNum)) {
				findings.push({
					level: "warning",
					code: "ORPHAN_PLAN",
					ref,
					message: `Plan ref doesn't match phase ${phaseNum}: ${join(phaseDir.name, planFile)}`,
				});
			}
		}
	}

	return findings;
}

/**
 * Check for runs referencing missing plans
 */
function checkRunOrphans(runs: Run[], phasesDir: string): Finding[] {
	const findings: Finding[] = [];

	for (const run of runs) {
		if (!planExists(run.plan_path)) {
			const ref = parsePlanRef(run.plan_path) ?? run.id;
			findings.push({
				level: "error",
				code: "RUN_ORPHAN",
				ref,
				message: `Run references missing plan: ${run.plan_path}`,
			});
		}
	}

	return findings;
}

/**
 * Check for completed runs without SUMMARY.md or SUMMARY.done.md
 * (SUMMARY lifecycle: draft → SUMMARY.md, verified → SUMMARY.done.md)
 */
function checkMissingSummaries(runs: Run[]): Finding[] {
	const findings: Finding[] = [];

	const completedRuns = runs.filter((r) => r.state === "complete");
	for (const run of completedRuns) {
		const summaryPath = run.plan_path.replace(/-PLAN\.md$/, "-SUMMARY.md");
		const summaryDonePath = run.plan_path.replace(/-PLAN\.md$/, "-SUMMARY.done.md");

		// Accept either SUMMARY.md (draft) or SUMMARY.done.md (finalized)
		if (!existsSync(summaryPath) && !existsSync(summaryDonePath)) {
			const ref = getRunPlanRef(run);
			findings.push({
				level: "warning",
				code: "RUN_MISSING_SUMMARY",
				ref,
				message: `Completed run has no SUMMARY.md: ${summaryPath}`,
			});
		}
	}

	return findings;
}

/**
 * Check for SUMMARY.autopass.md files (pending manual verification)
 * These indicate automated checks passed but manual checks were skipped
 */
function checkAutopassSummaries(phasesDir: string): Finding[] {
	const findings: Finding[] = [];
	if (!existsSync(phasesDir)) return findings;

	// Get all directories in plans (could be initiatives or phases)
	const topLevelDirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory());

	for (const topDir of topLevelDirs) {
		const topPath = join(phasesDir, topDir.name);

		// Check if this is an initiative dir (contains phase subdirs) or a phase dir
		const subDirs = readdirSync(topPath, { withFileTypes: true })
			.filter((d) => d.isDirectory());

		// If subdirs look like phases (match pattern), treat as initiative
		const hasPhaseSubdirs = subDirs.some((d) => /^\d+(?:\.\d+)?-/.test(d.name));

		if (hasPhaseSubdirs) {
			// Initiative directory - iterate through phase subdirs
			for (const phaseDir of subDirs) {
				const phaseFullPath = join(topPath, phaseDir.name);
				checkAutopassInDir(phaseFullPath, findings);
			}
		} else if (/^\d+(?:\.\d+)?-/.test(topDir.name)) {
			// Flat structure - topDir is itself a phase dir
			checkAutopassInDir(topPath, findings);
		}
	}

	return findings;
}

/**
 * Helper to check for autopass summaries in a directory
 */
function checkAutopassInDir(dirPath: string, findings: Finding[]): void {
	const autopassFiles = readdirSync(dirPath)
		.filter((f) => f.includes("-SUMMARY.autopass.md") || f === "SUMMARY.autopass.md");

	for (const autopassFile of autopassFiles) {
		const ref = autopassFile
			.replace("-SUMMARY.autopass.md", "")
			.replace("SUMMARY.autopass.md", basename(dirPath));
		findings.push({
			level: "warning",
			code: "SUMMARY_AUTOPASS",
			ref,
			message: `Pending manual verification: ${join(dirPath, autopassFile)}`,
		});
	}
}

/**
 * Check for stale runs (active but no recent activity)
 */
function checkStaleRuns(runs: Run[]): Finding[] {
	const findings: Finding[] = [];
	const staleThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
	const now = Date.now();

	const activeRuns = runs.filter((r) => matchState(r.state, "active"));
	for (const run of activeRuns) {
		const updatedAt = new Date(run.updated).getTime();
		if (now - updatedAt > staleThreshold) {
			const ref = getRunPlanRef(run);
			const days = Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000));
			findings.push({
				level: "info",
				code: "RUN_STALE",
				ref,
				message: `Active run with no activity for ${days} days`,
			});
		}
	}

	return findings;
}

/**
 * Check for ref mismatches (plan_path doesn't match expected location)
 */
function checkRefMismatches(runs: Run[]): Finding[] {
	const findings: Finding[] = [];

	for (const run of runs) {
		const expectedRef = parsePlanRef(run.plan_path);
		const actualRef = getRunPlanRef(run);

		// Check if the plan file name matches the plan ref
		const planFileName = basename(run.plan_path, ".md");
		const expectedFileName = `${expectedRef}-PLAN`;

		if (expectedRef && planFileName !== expectedFileName) {
			findings.push({
				level: "warning",
				code: "REF_MISMATCH",
				ref: actualRef,
				message: `Plan path suggests ref '${expectedRef}' but file is '${planFileName}.md'`,
			});
		}
	}

	return findings;
}

/**
 * Check for missing frontmatter fields in plans
 */
function checkFrontmatter(phasesDir: string): Finding[] {
	const findings: Finding[] = [];
	if (!existsSync(phasesDir)) return findings;

	const requiredFields = ["title", "phase", "plan"];

	const phaseDirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory());

	for (const phaseDir of phaseDirs) {
		const phaseFullPath = join(phasesDir, phaseDir.name);
		const planFiles = readdirSync(phaseFullPath)
			.filter((f) => f.endsWith("-PLAN.md"));

		for (const planFile of planFiles) {
			const fullPath = join(phaseFullPath, planFile);
			const ref = planFile.replace("-PLAN.md", "");

			try {
				const content = readFileSync(fullPath, "utf-8");
				const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

				if (!frontmatterMatch) {
					findings.push({
						level: "error",
						code: "FRONTMATTER_MISSING",
						ref,
						message: "Plan has no YAML frontmatter",
					});
					continue;
				}

				const frontmatter = frontmatterMatch[1];
				for (const field of requiredFields) {
					const fieldPattern = new RegExp(`^${field}:`, "m");
					if (!fieldPattern.test(frontmatter)) {
						findings.push({
							level: "warning",
							code: "FRONTMATTER_MISSING",
							ref,
							message: `Plan missing required field: ${field}`,
						});
					}
				}
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				findings.push({
					level: "error",
					code: "FRONTMATTER_MISSING",
					ref,
					message: `Failed to read plan: ${fullPath} (${errMsg})`,
				});
			}
		}
	}

	return findings;
}

/**
 * Check for invalid states in runs
 */
function checkInvalidStates(runs: Run[]): Finding[] {
	const findings: Finding[] = [];
	const validStates = new Set(Object.keys(VALID_TRANSITIONS));

	for (const run of runs) {
		if (!validStates.has(run.state)) {
			const ref = getRunPlanRef(run);
			findings.push({
				level: "error",
				code: "STATE_INVALID",
				ref,
				message: `Invalid state: '${run.state}'`,
			});
		}
	}

	return findings;
}

/**
 * Check for plans missing <verification> section
 * Handles initiative-based directory structure: plans/{initiative}/{phase}/{plan}-PLAN.md
 */
function checkMissingVerification(plansDir: string): Finding[] {
	const findings: Finding[] = [];
	if (!existsSync(plansDir)) return findings;

	// Get all directories in plans (could be initiatives or phases)
	const topLevelDirs = readdirSync(plansDir, { withFileTypes: true })
		.filter((d) => d.isDirectory());

	for (const topDir of topLevelDirs) {
		const topPath = join(plansDir, topDir.name);

		// Check if this is an initiative dir (contains phase subdirs) or a phase dir
		const subDirs = readdirSync(topPath, { withFileTypes: true })
			.filter((d) => d.isDirectory());

		// If subdirs look like phases (match pattern), treat as initiative
		const hasPhaseSubdirs = subDirs.some((d) => /^\d+(?:\.\d+)?-/.test(d.name));

		if (hasPhaseSubdirs) {
			// Initiative directory - iterate through phase subdirs
			for (const phaseDir of subDirs) {
				const phaseFullPath = join(topPath, phaseDir.name);
				checkPlansInDir(phaseFullPath, findings);
			}
		} else if (/^\d+(?:\.\d+)?-/.test(topDir.name)) {
			// Flat structure - topDir is itself a phase dir
			checkPlansInDir(topPath, findings);
		}
	}

	return findings;
}

/**
 * Helper to check all plans in a directory for missing verification
 */
function checkPlansInDir(dirPath: string, findings: Finding[]): void {
	const planFiles = readdirSync(dirPath)
		.filter((f) => f.endsWith("-PLAN.md"));

	for (const planFile of planFiles) {
		const fullPath = join(dirPath, planFile);
		const ref = planFile.replace("-PLAN.md", "");

		try {
			const content = readFileSync(fullPath, "utf-8");
			if (!hasVerificationSection(content)) {
				findings.push({
					level: "warning",
					code: "VERIFICATION_MISSING",
					ref,
					message: "Plan missing <verification> section",
				});
			}
		} catch {
			// File read errors are handled by checkFrontmatter
		}
	}
}

export function registerCheckCommands(program: Command): void {
	const checkCmd = program
		.command("check")
		.description("Check commands: scan (invariants), record (verification), list");

	// ============================================
	// check scan: Run invariant checks (ADR-0006)
	// Read-only, deterministic, safe to run constantly
	// ============================================
	checkCmd
		.command("scan")
		.description("Run invariant checks (ADR-0006: read-only, never fixes)")
		.option("--json", "Output findings as JSON")
		.option("--level <level>", "Minimum level to report (error|warning|info)", "info")
		.action((options: { json?: boolean; level?: string }) => {
			const config = loadConfig();
			const phasesDir = config.paths.plans;
			const tracks = listRuns();

			// Run all checks
			const findings: Finding[] = [
				// Phase checks
				...checkPhaseCollisions(phasesDir),
				...checkPlanCollisions(phasesDir),
				...checkOrphanPlans(phasesDir),
				// Run checks
				...checkRunOrphans(tracks, phasesDir),
				...checkMissingSummaries(tracks),
				...checkStaleRuns(tracks),
				// Ref integrity checks
				...checkRefMismatches(tracks),
				...checkFrontmatter(phasesDir),
				...checkInvalidStates(tracks),
				// Plan content checks
				...checkMissingVerification(phasesDir),
				// SUMMARY lifecycle checks (06.6-50)
				...checkAutopassSummaries(phasesDir),
			];

			// Filter by level
			const levelOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
			const minLevel = levelOrder[options.level ?? "info"] ?? 2;
			const filtered = findings.filter((f) => levelOrder[f.level] <= minLevel);

			// Sort by level (errors first)
			filtered.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

			// JSON output
			if (options.json) {
				console.log(JSON.stringify({ findings: filtered, count: filtered.length }, null, 2));
				process.exit(filtered.some((f) => f.level === "error") ? 1 : 0);
			}

			// Human output
			if (filtered.length === 0) {
				console.log("✓ No invariant violations found");
				return;
			}

			const errorCount = filtered.filter((f) => f.level === "error").length;
			const warnCount = filtered.filter((f) => f.level === "warning").length;
			const infoCount = filtered.filter((f) => f.level === "info").length;

			console.log(`Found ${filtered.length} finding(s):\n`);

			for (const f of filtered) {
				const icon = f.level === "error" ? "✗" : f.level === "warning" ? "⚠" : "○";
				console.log(`  ${icon} [${f.code}] ${f.ref}: ${f.message}`);
			}

			console.log("");
			const parts = [];
			if (errorCount > 0) parts.push(`${errorCount} error(s)`);
			if (warnCount > 0) parts.push(`${warnCount} warning(s)`);
			if (infoCount > 0) parts.push(`${infoCount} info`);
			console.log(`Summary: ${parts.join(", ")}`);

			// Exit code: 1 if errors
			if (errorCount > 0) {
				process.exit(1);
			}
		});

	// ============================================
	// check record: Record result for a manual check
	// ============================================
	checkCmd
		.command("record <name>")
		.description("Record result for a manual check (requires verifying/* state)")
		.option("--pass", "Mark check as passed")
		.option("--fail", "Mark check as failed")
		.option("--reason <reason>", "Reason for the result (especially for --fail)")
		.option("--by <actor>", 'Who recorded: "agent" (default) or "human"', "agent")
		.option("--plan <ref>", "Specify plan ref (auto-detects if only one verifying)")
		.action(
			(
				checkName: string,
				options: {
					pass?: boolean;
					fail?: boolean;
					reason?: string;
					by?: string;
					plan?: string;
				},
			) => {
				// Require --pass or --fail
				if (!options.pass && !options.fail) {
					console.error("Error: --pass or --fail required");
					console.error(`Usage: tiller check record ${checkName} --pass`);
					console.error(
						`   Or: tiller check record ${checkName} --fail --reason "..."`,
					);
					process.exit(1);
				}

				if (options.pass && options.fail) {
					console.error("Error: cannot use both --pass and --fail");
					process.exit(1);
				}

				// Find track - fails hard on ambiguity
				const result = getRunForCheck(options.plan);
				if ("error" in result) {
					console.error(result.error);
					process.exit(2);
				}
				const track = result.track;

				const planRef = getRunPlanRef(track);

				// Validate state - must be in verifying/*
				if (!matchState(track.state, "verifying")) {
					console.error(
						`Cannot record check: plan ${planRef} is '${track.state}', not verifying/*`,
					);
					console.error("Run verification first: tiller run verify");
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

				// Require YAML format
				if (!hasYamlVerificationSection(planContent)) {
					console.error(
						"Error: tiller check record requires YAML-format <verification> section",
					);
					process.exit(1);
				}

				const parsed = parseVerificationYaml(planContent);
				if (!parsed.success) {
					console.error("Failed to parse verification section:");
					parsed.errors.forEach((e) => console.error(`  - ${e}`));
					process.exit(1);
				}

				const checkDefs: VerificationCheckDef[] = parsed.checks;

				// Find the check by name
				const checkDef = checkDefs.find((c) => c.name === checkName);
				if (!checkDef) {
					const validNames = checkDefs.map((c) => c.name).join(", ");
					console.error(`Unknown check '${checkName}'.`);
					console.error(`Valid checks: ${validNames}`);
					process.exit(1);
				}

				// Validate it's a manual check
				if (!checkDef.manual) {
					console.error(`Cannot record '${checkName}': not a manual check.`);
					console.error("Only checks with 'manual: true' can be recorded.");
					console.error("Cmd checks are executed automatically by 'tiller run verify'.");
					process.exit(1);
				}

				// Append the manual_recorded event
				const status = options.pass ? "pass" : "fail";
				const by = options.by === "human" ? "human" : "agent";

				appendVerificationEvent(track, {
					type: "manual_recorded",
					name: checkName,
					status,
					reason: options.reason,
					at: new Date().toISOString(),
					by,
				});

				// Derive snapshot to check overall status
				const snapshot = deriveVerificationSnapshot(track, checkDefs);
				const overallStatus = getVerificationStatus(snapshot);

				// Auto-transition based on aggregated result
				let targetState: RunState | null = null;

				if (overallStatus === "fail") {
					targetState = "verifying/failed";
				} else if (overallStatus === "pass") {
					targetState = "verifying/passed";
				}
				// "pending" → stay in current state

				if (targetState && track.state !== targetState) {
					const transition = applyTransition(track, targetState, by);
					if (!transition.success) {
						console.error(`Warning: failed to transition: ${transition.error}`);
					}
				}

				// Log event
				logEvent({
					event: "manual_check_recorded",
					track: track.id,
					check: checkName,
					status,
					overall: overallStatus,
				});

				// Output TOON
				outputTOON({
					check_record: {
						plan: planRef,
						check: {
							name: checkName,
							status,
							by,
							...(options.reason && { reason: options.reason }),
						},
						snapshot: {
							checks: snapshot.checks.map((c) => ({
								name: c.name,
								kind: c.kind,
								status: c.status,
							})),
							manual_pending: snapshot.manual_pending,
							overall: overallStatus,
						},
						state: track.state,
						next:
							overallStatus === "pass"
								? "tiller run complete"
								: overallStatus === "fail"
									? "tiller fix"
									: snapshot.checks
											.filter((c) => c.kind === "manual" && c.status === "pending")
											.map((c) => `tiller check record ${c.name} --pass`),
					},
				});
			},
		);

	// ============================================
	// check list: Show checks for a plan
	// ============================================
	checkCmd
		.command("list [ref]")
		.description("List verification checks for a plan")
		.action((ref?: string) => {
			const result = getRunForCheck(ref);
			if ("error" in result) {
				console.error(result.error);
				process.exit(2);
			}
			const track = result.track;

			const planRef = getRunPlanRef(track);

			// Load and parse PLAN.md
			let planContent: string;
			try {
				planContent = readPlanFile(track.plan_path);
			} catch (e) {
				const errMsg = e instanceof Error ? e.message : String(e);
				console.error(`Failed to read plan: ${track.plan_path}`);
				console.error(`  Error: ${errMsg}`);
				process.exit(1);
			}

			if (!hasYamlVerificationSection(planContent)) {
				console.error("No YAML <verification> section found");
				process.exit(1);
			}

			const parsed = parseVerificationYaml(planContent);
			if (!parsed.success) {
				console.error("Failed to parse verification section:");
				parsed.errors.forEach((e) => console.error(`  - ${e}`));
				process.exit(1);
			}

			const checkDefs: VerificationCheckDef[] = parsed.checks;

			// Get current status if in verifying state
			let snapshot = null;
			if (matchState(track.state, "verifying")) {
				snapshot = deriveVerificationSnapshot(track, checkDefs);
			}

			console.log(`Plan: ${planRef}`);
			console.log(`State: ${track.state}`);
			console.log(`\nChecks (${checkDefs.length}):`);

			for (const def of checkDefs) {
				const kind = def.manual ? "manual" : "cmd";
				const derived = snapshot?.checks.find((c) => c.name === def.name);
				const status = derived?.status ?? "—";
				const icon =
					status === "pass" ? "✓" : status === "fail" ? "✗" : status === "error" ? "!" : "○";

				console.log(`  ${icon} ${def.name} [${kind}] ${status}`);
			}

			if (snapshot) {
				console.log(`\nOverall: ${getVerificationStatus(snapshot)}`);
				if (snapshot.manual_pending) {
					const pending = snapshot.checks.filter(
						(c) => c.kind === "manual" && c.status === "pending",
					);
					console.log(`\nManual checks pending (${pending.length}):`);
					for (const c of pending) {
						console.log(`  tiller check record ${c.name} --pass`);
					}
				}
			}
		});
}
