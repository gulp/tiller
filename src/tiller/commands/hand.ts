/**
 * Tiller hand commands - Multi-agent worker coordination
 *
 * Commands:
 * - hand reserve [--track=<id>]  - Create hand slot
 * - hand list                    - Show all hands
 * - hand status <name>           - Detailed view
 * - hand kill <name>             - Terminate hand
 */

import type { Command } from "commander";
import { killHand, listHands, loadHand, reserveHand } from "../hands/file.js";
import { getDefaultRun, listRuns } from "../state/run.js";

/**
 * Format relative time (e.g., "2 min ago")
 */
function relativeTime(isoString: string): string {
	const now = Date.now();
	const then = new Date(isoString).getTime();
	const diff = now - then;

	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return `${seconds} sec ago`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hr ago`;

	const days = Math.floor(hours / 24);
	return `${days} day ago`;
}

/**
 * Pad string to width
 */
function pad(str: string, width: number): string {
	return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function showDeprecationWarning(subcommand: string): void {
	const migration: Record<string, string> = {
		reserve: "tiller mate add",
		list: "tiller mate list",
		status: "tiller mate status",
		kill: "tiller mate remove",
	};
	console.error(`⚠ 'tiller hand ${subcommand}' is deprecated.`);
	console.error(`  Use: ${migration[subcommand] || "tiller mate"}`);
	console.error("");
	console.error("Migration guide:");
	console.error("  tiller hand reserve  →  tiller mate add <name>");
	console.error("  tiller hand list     →  tiller mate list");
	console.error("  tiller hand status   →  tiller mate status <name>");
	console.error("  tiller hand kill     →  tiller mate remove <name>");
}

export function registerHandCommands(program: Command): void {
	const hand = program
		.command("hand")
		.description("[DEPRECATED] Use 'tiller mate' instead");

	// ============================================
	// reserve: Create hand slot
	// ============================================
	hand
		.command("reserve")
		.description("[DEPRECATED] Use 'tiller mate add' instead")
		.option("--run <id>", "Run to bind hand to")
		.action(async (opts: { run?: string }) => {
			showDeprecationWarning("reserve");
			// Find run - use specified, or active, or first available
			let runId = opts.run;

			if (!runId) {
				const defaultRun = getDefaultRun();
				if (defaultRun) {
					runId = defaultRun.id;
				} else {
					const runs = listRuns();
					if (runs.length === 0) {
						console.error("No run available. Run tiller init first.");
						process.exit(1);
					}
					runId = runs[0].id;
				}
			}

			try {
				const handFile = reserveHand(runId);
				console.log(
					`Reserved hand: ${handFile.name} (run: ${handFile.run_id})`,
				);
			} catch (err) {
				console.error(`Failed to reserve hand: ${(err as Error).message}`);
				process.exit(1);
			}
		});

	// ============================================
	// list: Show all hands
	// ============================================
	hand
		.command("list")
		.description("[DEPRECATED] Use 'tiller mate list' instead")
		.action(() => {
			showDeprecationWarning("list");
			const hands = listHands();

			if (hands.length === 0) {
				console.log("No hands reserved.");
				return;
			}

			// Table header
			console.log(
				`${pad("NAME", 16)} ${pad("STATE", 10)} ${pad("RUN", 16)} ${pad("RESERVED", 12)}`,
			);

			// Table rows
			for (const h of hands) {
				console.log(
					`${pad(h.name, 16)} ${pad(h.state, 10)} ${pad(h.run_id, 16)} ${pad(relativeTime(h.reserved_at), 12)}`,
				);
			}
		});

	// ============================================
	// status: Detailed view of one hand
	// ============================================
	hand
		.command("status <name>")
		.description("[DEPRECATED] Use 'tiller mate status' instead")
		.action((name: string) => {
			showDeprecationWarning("status");
			const h = loadHand(name);

			if (!h) {
				console.error(`Hand not found: ${name}`);
				process.exit(1);
			}

			console.log(`Hand: ${h.name}`);
			console.log(`State: ${h.state}`);
			console.log(`Run: ${h.run_id}`);
			console.log(`Reserved: ${h.reserved_at}`);

			if (h.locked_at) {
				console.log(`Locked at: ${h.locked_at}`);
			}
			if (h.locked_by_pid) {
				console.log(`Locked by PID: ${h.locked_by_pid}`);
			}
		});

	// ============================================
	// kill: Terminate hand
	// ============================================
	hand
		.command("kill <name>")
		.description("[DEPRECATED] Use 'tiller mate remove' instead")
		.action((name: string) => {
			showDeprecationWarning("kill");
			const h = loadHand(name);

			if (!h) {
				console.error(`Hand not found: ${name}`);
				process.exit(1);
			}

			const result = killHand(name);

			if (!result) {
				console.error("Cannot kill running hand. Stop the process first.");
				process.exit(1);
			}

			console.log(`Killed hand: ${name}`);
		});
}
