/**
 * Tiller assign command - Assign plans to mates
 *
 * Usage: tiller assign <plan-ref> --to <mate>
 */

import type { Command } from "commander";
import { addMate, getMate, updateMate } from "../mate/registry.js";
import { getRunPlanRef, resolveRunRef } from "../state/run.js";

export function registerAssignCommand(program: Command): void {
	program
		.command("assign <plan-ref>")
		.description("Assign a plan to a mate")
		.requiredOption("--to <mate>", "Mate name to assign to")
		.option("--create-mate", "Create mate if doesn't exist")
		.action((planRef: string, opts: { to: string; createMate?: boolean }) => {
			// Validate plan exists by trying to resolve track
			const track = resolveRunRef(planRef);
			if (!track) {
				console.error(`Plan not found: ${planRef}`);
				console.error("Use 'tiller list' to see available plans/runs");
				process.exit(1);
			}

			// Get or create mate
			let mate = getMate(opts.to);
			if (!mate) {
				if (opts.createMate) {
					mate = addMate(opts.to);
					console.log(`Created mate: ${opts.to}`);
				} else {
					console.error(`Mate not found: ${opts.to}`);
					console.error(
						`Use --create-mate to create, or: tiller mate add ${opts.to}`,
					);
					process.exit(1);
				}
			}

			// Check mate is available
			if (mate.state === "sailing") {
				console.error(
					`Mate ${opts.to} is currently sailing. Wait for completion.`,
				);
				process.exit(1);
			}

			// Assign plan
			const resolvedRef = getRunPlanRef(track);
			updateMate(opts.to, {
				assignedPlan: resolvedRef,
				state: mate.state === "claimed" ? "claimed" : "available",
			});

			console.log(`✓ Assigned ${resolvedRef} to ${opts.to}`);
			console.log(`  Plan: ${track.intent || resolvedRef}`);
			console.log(`  Mate state: ${mate.state}`);
			if (mate.state === "claimed") {
				console.log(`  → Mate can now run: tiller sail`);
			} else {
				console.log(`  → Waiting for mate to: tiller claim ${opts.to}`);
			}
		});
}
