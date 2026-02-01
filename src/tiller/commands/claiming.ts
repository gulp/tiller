/**
 * Claiming commands for multi-track agent coordination
 *
 * Commands: claim, release, gc
 */

import type { Command } from "commander";
import { linkAgentToRun } from "../state/agent.js";
import { logEvent } from "../state/events.js";
import {
	claimRun,
	detectFileConflicts,
	isRunAvailable,
	listRuns,
	loadRun,
	releaseRun,
} from "../state/run.js";
import { matchState } from "../types/index.js";

/**
 * Generate agent ID from env or random
 */
function getAgentId(optionAgent?: string): string {
	return (
		optionAgent ||
		process.env.CLAUDE_SESSION_ID ||
		`agent-${Date.now().toString(36)}`
	);
}

export function registerClaimingCommands(program: Command): void {
	// claim command
	program
		.command("claim <run-id>")
		.description("Claim a run for exclusive work")
		.option(
			"--agent <id>",
			"Agent/session ID (default: env CLAUDE_SESSION_ID or generated)",
		)
		.option("--ttl <minutes>", "Claim TTL in minutes (default: 30)", "30")
		.option("--force", "Claim even if conflicts exist")
		.action(
			async (
				runId: string,
				options: { agent?: string; ttl?: string; force?: boolean },
			) => {
				const run = loadRun(runId);

				if (!run) {
					console.error(`Run not found: ${runId}`);
					process.exit(2);
				}

				// Check if already claimed
				if (!isRunAvailable(run)) {
					console.error(`Run already claimed by: ${run.claimed_by}`);
					console.error(`Claimed at: ${run.claimed_at}`);
					console.error(`Expires: ${run.claim_expires}`);
					console.error("");
					console.error("If the claimer crashed, run: tiller gc");
					process.exit(1);
				}

				// Check for file conflicts with active runs (HSM: any active/* substate)
				const activeRuns = listRuns().filter((t) =>
					matchState(t.state, "active"),
				);
				const conflicts = detectFileConflicts(run, activeRuns);

				if (conflicts.length > 0 && !options.force) {
					console.error(
						`Warning: File conflicts with: ${conflicts.join(", ")}`,
					);
					console.error("Use --force to claim anyway.");
					process.exit(1);
				}

				// Claim the run
				const ttlMinutes = parseInt(options.ttl || "30", 10);
				const agentId = getAgentId(options.agent);
				const result = claimRun(run, agentId, ttlMinutes);

				if (!result.success) {
					console.error(`Failed to claim: ${result.error}`);
					process.exit(1);
				}

				// Update agent status if TILLER_AGENT is set
				const tillerAgent = process.env.TILLER_AGENT;
				if (tillerAgent) {
					await linkAgentToRun(tillerAgent, runId);
				}

				console.log(`✓ Claimed run: ${runId}`);
				console.log(`  Agent: ${agentId}`);
				console.log(
					`  Expires: ${new Date(result.track?.claim_expires!).toLocaleString()}`,
				);

				if (conflicts.length > 0) {
					console.log(`  ⚠ Conflicts: ${conflicts.join(", ")}`);
				}
			},
		);

	// release command
	program
		.command("release <run-id>")
		.description("Release claim on a run")
		.option("--agent <id>", "Agent ID (must match claimer)")
		.action(async (runId: string, options: { agent?: string }) => {
			const run = loadRun(runId);

			if (!run) {
				console.error(`Run not found: ${runId}`);
				process.exit(2);
			}

			if (!run.claimed_by) {
				console.log(`Run ${runId} is not claimed.`);
				process.exit(0);
			}

			// Verify agent owns claim (if agent specified)
			const agentId = options.agent || process.env.CLAUDE_SESSION_ID;
			if (agentId && run.claimed_by !== agentId) {
				console.error(
					`Cannot release: claimed by ${run.claimed_by}, not ${agentId}`,
				);
				process.exit(1);
			}

			const previousClaimer = run.claimed_by;
			releaseRun(run);
			logEvent({
				event: "run_released",
				track: runId,
				previous_claimer: previousClaimer,
			});

			// Clear agent's run if TILLER_AGENT matches the claimer
			const tillerAgent = process.env.TILLER_AGENT;
			if (tillerAgent && tillerAgent === previousClaimer) {
				await linkAgentToRun(tillerAgent, null);
			}

			console.log(`✓ Released run: ${runId}`);
		});

	// gc command
	program
		.command("gc")
		.description("Release expired run claims (use when an agent crashed)")
		.option("--dry-run", "Show what would be cleaned without doing it")
		.action(async (options: { dryRun?: boolean }) => {
			const allRuns = listRuns();
			const now = new Date();

			const staleRuns = allRuns.filter((r) => {
				if (!r.claimed_by || !r.claim_expires) return false;
				return new Date(r.claim_expires) < now;
			});

			if (staleRuns.length === 0) {
				console.log("No stale claims found.");
				return;
			}

			console.log(`Found ${staleRuns.length} stale claim(s):`);

			for (const run of staleRuns) {
				console.log(
					`  ${run.id}: claimed by ${run.claimed_by}, expired ${run.claim_expires}`,
				);

				if (!options.dryRun) {
					releaseRun(run);
					logEvent({ event: "stale_claim_gc", track: run.id });
				}
			}

			if (options.dryRun) {
				console.log("\n(dry run - no changes made)");
			} else {
				console.log(`\n✓ Cleaned ${staleRuns.length} stale claim(s)`);
			}
		});
}
