/**
 * Tiller prune command - Garbage collection for dead state
 *
 * Semantic separation:
 * - check: finds facts (read-only)
 * - repair: fixes broken invariants (structural fixes)
 * - prune: reclaims semantically dead state (GC)
 *
 * Commands:
 * - prune orphans   Delete runs whose plan files no longer exist
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { logEvent } from "../state/events.js";
import { planExists } from "../state/paths.js";
import { getRunPlanRef, listRuns } from "../state/run.js";
import type { Run } from "../types/index.js";
import { outputTOON } from "../types/toon.js";
import { PATHS } from "../state/config.js";

// ============================================================================
// Types
// ============================================================================

type OrphanClassification = "safe" | "dangerous";

interface OrphanRun {
	run: Run;
	planRef: string;
	classification: OrphanClassification;
	reason: string;
}

interface PruneResult {
	scanned: number;
	orphans: OrphanRun[];
	deleted: number;
	refused: number;
}

// ============================================================================
// Orphan Detection
// ============================================================================

/**
 * Classify orphan as safe or dangerous based on state.
 * Safe: proposed, abandoned, complete (no active work)
 * Dangerous: active/*, verifying/* (work in flight)
 */
function classifyOrphan(run: Run): OrphanClassification {
	const state = run.state;

	// Dangerous: active work in progress
	if (state.startsWith("active/") || state.startsWith("verifying/")) {
		return "dangerous";
	}

	// Safe: no active work
	// proposed, approved, ready, abandoned, complete
	return "safe";
}

/**
 * Detect orphan runs (runs whose plan_path doesn't exist)
 */
function detectOrphans(): OrphanRun[] {
	const runs = listRuns();
	const orphans: OrphanRun[] = [];

	for (const run of runs) {
		if (!run.plan_path) {
			orphans.push({
				run,
				planRef: getRunPlanRef(run),
				classification: "safe",
				reason: "No plan_path defined",
			});
			continue;
		}

		if (!planExists(run.plan_path)) {
			const classification = classifyOrphan(run);
			orphans.push({
				run,
				planRef: getRunPlanRef(run),
				classification,
				reason: `Plan file missing: ${run.plan_path}`,
			});
		}
	}

	return orphans;
}

// ============================================================================
// Prune Operations
// ============================================================================

/**
 * Delete an orphan run with full audit logging.
 * Logs complete run JSON to events.jsonl BEFORE delete (recovery path).
 */
function pruneOrphan(orphan: OrphanRun): boolean {
	const runFile = join(PATHS.RUNS_DIR, `${orphan.run.id}.json`);

	if (!existsSync(runFile)) {
		return false;
	}

	// Log BEFORE delete - full JSON is the recovery path
	logEvent({
		event: "orphan_pruned",
		run_id: orphan.run.id,
		plan_ref: orphan.planRef,
		state: orphan.run.state,
		plan_path: orphan.run.plan_path,
		classification: orphan.classification,
		reason: orphan.reason,
		full_run: orphan.run, // Complete run JSON for recovery
		by: "agent",
	});

	// Delete the run file
	unlinkSync(runFile);
	return true;
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerPruneCommand(program: Command): void {
	const prune = program
		.command("prune")
		.description("Garbage collection for dead state")
		.action(() => {
			console.log("Usage: tiller prune <subcommand>");
			console.log("");
			console.log("Subcommands:");
			console.log("  orphans    Delete runs whose plan files no longer exist");
			console.log("");
			console.log("Options:");
			console.log("  --dry-run    Show what would be deleted");
			console.log("  --force, -y  Delete dangerous orphans (active/verifying)");
		});

	// Subcommand: orphans
	prune
		.command("orphans")
		.description("Delete runs whose plan files no longer exist")
		.option("--dry-run", "Show what would be deleted without mutating")
		.option("--force, -y", "Delete dangerous orphans (active/*, verifying/*)")
		.option("--json", "Output as JSON")
		.action(
			(opts: {
				dryRun?: boolean;
				force?: boolean;
				y?: boolean;
				json?: boolean;
			}) => {
				const force = opts.force || opts.y || false;
				const dryRun = opts.dryRun ?? false;

				const runs = listRuns();
				const orphans = detectOrphans();

				const safe = orphans.filter((o) => o.classification === "safe");
				const dangerous = orphans.filter(
					(o) => o.classification === "dangerous",
				);

				const result: PruneResult = {
					scanned: runs.length,
					orphans,
					deleted: 0,
					refused: 0,
				};

				if (!dryRun) {
					// Delete safe orphans
					for (const orphan of safe) {
						if (pruneOrphan(orphan)) {
							result.deleted++;
						}
					}

					// Handle dangerous orphans
					if (force) {
						for (const orphan of dangerous) {
							if (pruneOrphan(orphan)) {
								result.deleted++;
							}
						}
					} else {
						result.refused = dangerous.length;
					}
				}

				// JSON output
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				// TOON output
				const toonData = {
					prune_orphans: {
						scanned: result.scanned,
						orphans_found: orphans.length,
						safe: safe.map((o) => ({
							plan_ref: o.planRef,
							state: o.run.state,
							reason: o.reason,
						})),
						dangerous: dangerous.map((o) => ({
							plan_ref: o.planRef,
							state: o.run.state,
							reason: o.reason,
						})),
						deleted: result.deleted,
						refused: result.refused,
						dry_run: dryRun,
					},
				};

				const printPretty = () => {
					if (orphans.length === 0) {
						console.log("No orphan runs found.");
						return;
					}

					console.log(`tiller prune orphans${dryRun ? " --dry-run" : ""}`);
					console.log("─".repeat(60));

					if (safe.length > 0) {
						console.log(`\nSafe orphans (${safe.length}):`);
						for (const o of safe) {
							const action = dryRun ? "would delete" : "deleted";
							console.log(`  ✓ ${o.planRef} [${o.run.state}] - ${action}`);
						}
					}

					if (dangerous.length > 0) {
						console.log(`\nDangerous orphans (${dangerous.length}):`);
						for (const o of dangerous) {
							const action =
								dryRun ? "would delete" : force ? "deleted" : "REFUSED";
							const icon = force || dryRun ? "⚠" : "✗";
							console.log(`  ${icon} ${o.planRef} [${o.run.state}] - ${action}`);
						}
						if (!force && !dryRun) {
							console.log("\n  Use --force to delete dangerous orphans.");
						}
					}

					console.log("─".repeat(60));
					console.log(
						`Scanned: ${result.scanned}, Deleted: ${result.deleted}, Refused: ${result.refused}`,
					);
				};

				outputTOON(toonData, {
					agent_hint: `Pruned ${result.deleted} orphan runs. ${result.refused} dangerous orphans refused (use --force).`,
					prettyFn: printPretty,
				});
			},
		);
}
