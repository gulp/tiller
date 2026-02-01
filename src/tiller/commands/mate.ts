/**
 * Tiller mate commands - Multi-agent worker coordination
 *
 * Commands:
 * - mate add <name>     - Add a new mate to the registry
 * - mate list           - Show all mates
 * - mate status <name>  - Detailed mate view
 * - mate remove <name>  - Remove a mate from registry
 */

import type { Command } from "commander";
import {
	addMate,
	gcStaleMates,
	getCurrentSession,
	getMate,
	isMateStale,
	listMates,
	removeMate,
	updateMate,
} from "../mate/registry.js";
import { MATE_ENV } from "../mate/types.js";

export function registerMateCommands(program: Command): void {
	const mate = program
		.command("mate")
		.description("Manage mate registry for multi-agent coordination");

	mate
		.command("add <name>")
		.description("Add a new mate to the registry")
		.action((name: string) => {
			try {
				const m = addMate(name);
				console.log(`✓ Added mate: ${name}`);
				console.log(`  State: ${m.state}`);
			} catch (e) {
				console.error(`Error: ${(e as Error).message}`);
				process.exit(1);
			}
		});

	mate
		.command("list")
		.description("List all mates in the registry")
		.option("--json", "Output as JSON")
		.action((opts: { json?: boolean }) => {
			const mates = listMates();
			if (opts.json) {
				console.log(JSON.stringify(mates, null, 2));
				return;
			}
			if (mates.length === 0) {
				console.log("No mates registered.");
				console.log("Add one with: tiller mate add <name>");
				return;
			}
			console.log("Mates:");
			for (const m of mates) {
				const plan = m.assignedPlan ? ` → ${m.assignedPlan}` : "";
				const pid = m.claimedBy ? ` (PID ${m.claimedBy})` : "";
				console.log(`  ${m.name} [${m.state}]${plan}${pid}`);
			}
		});

	mate
		.command("remove <name>")
		.description("Remove a mate from the registry")
		.action((name: string) => {
			try {
				removeMate(name);
				console.log(`✓ Removed mate: ${name}`);
			} catch (e) {
				console.error(`Error: ${(e as Error).message}`);
				process.exit(1);
			}
		});

	mate
		.command("status <name>")
		.description("Show detailed status of a mate")
		.action((name: string) => {
			const m = getMate(name);
			if (!m) {
				console.error(`Mate not found: ${name}`);
				process.exit(1);
			}
			console.log(`Mate: ${m.name}`);
			console.log(`State: ${m.state}`);
			console.log(`Assigned: ${m.assignedPlan || "(none)"}`);
			console.log(
				`Claimed by: ${m.claimedBy ? `PID ${m.claimedBy}` : "(unclaimed)"}`,
			);
			console.log(`Created: ${m.createdAt}`);
			console.log(`Updated: ${m.updatedAt}`);
		});

	mate
		.command("claim <name>")
		.description("Claim a mate identity for this session")
		.action((name: string) => {
			const m = getMate(name);
			if (!m) {
				console.error(`Mate not found: ${name}`);
				console.error("Available mates: tiller mate list");
				process.exit(1);
			}

			// Check if already claimed by another process
			if (m.claimedBy && m.claimedBy !== process.pid) {
				// Check if claiming process is still alive
				try {
					process.kill(m.claimedBy, 0); // signal 0 = check existence
					console.error(`Mate ${name} is claimed by PID ${m.claimedBy}`);
					console.error("Release with: tiller mate unclaim (in that session)");
					process.exit(1);
				} catch {
					// Process is dead, we can reclaim
					console.log(`Reclaiming stale mate (PID ${m.claimedBy} is gone)`);
				}
			}

			// Claim the mate
			const sessionId = getCurrentSession();
			updateMate(name, {
				state: "claimed",
				claimedBy: process.pid,
				claimedBySession: sessionId,
				claimedAt: new Date().toISOString(),
			});

			// Set environment for this session
			process.env[MATE_ENV.TILLER_MATE] = name;
			process.env[MATE_ENV.BD_ACTOR] = name;

			console.log(`✓ Claimed: ${name}`);
			console.log(`  PID: ${process.pid}`);

			if (m.assignedPlan) {
				console.log(`  Assigned: ${m.assignedPlan}`);
				console.log("\nNext: tiller sail");
			} else {
				console.log("  Assigned: (none)");
				console.log(
					`\nWaiting for orchestrator to: tiller assign <plan> --to ${name}`,
				);
			}
		});

	mate
		.command("unclaim")
		.description("Release claimed mate identity")
		.action(() => {
			const mateName = process.env[MATE_ENV.TILLER_MATE];
			if (!mateName) {
				console.error("No mate claimed in this session.");
				process.exit(1);
			}

			const m = getMate(mateName);
			if (!m) {
				console.error(`Mate not found: ${mateName}`);
				process.exit(1);
			}

			if (m.claimedBy !== process.pid) {
				console.error(`Mate ${mateName} is not claimed by this session.`);
				process.exit(1);
			}

			updateMate(mateName, {
				state: "available",
				claimedBy: null,
				claimedBySession: null,
				claimedAt: null,
			});

			delete process.env[MATE_ENV.TILLER_MATE];
			delete process.env[MATE_ENV.BD_ACTOR];

			console.log(`✓ Released: ${mateName}`);
		});

	mate
		.command("gc")
		.description("Garbage collect stale mates (dead PIDs, old sessions)")
		.option("--dry-run", "Show what would be released without doing it")
		.action((opts: { dryRun?: boolean }) => {
			const mates = listMates();
			const stale = mates.filter((m) => isMateStale(m));

			if (stale.length === 0) {
				console.log("No stale mates found.");
				return;
			}

			if (opts.dryRun) {
				console.log("Stale mates (dry run):");
				for (const m of stale) {
					console.log(
						`  ${m.name} [${m.state}] - PID ${m.claimedBy}, session ${m.claimedBySession?.slice(0, 8) || "none"}...`,
					);
				}
				console.log(
					`\nRun without --dry-run to release ${stale.length} mate(s).`,
				);
				return;
			}

			const released = gcStaleMates();
			console.log(`✓ Released ${released.length} stale mate(s):`);
			for (const name of released) {
				console.log(`  ${name}`);
			}
		});
}
