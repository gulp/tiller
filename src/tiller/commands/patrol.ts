/**
 * Tiller patrol command - Unattended worker loop
 *
 * Claims a mate identity and patrols for work from beads.
 *
 * Usage:
 *   tiller patrol <mate-name> [--once] [--poll-interval=5000]
 */

import { execSync } from "node:child_process";
import type { Command } from "commander";
import { claimTask, findReadyTasks } from "../hands/claim.js";
import { getCurrentSession, getMate, updateMate } from "../mate/registry.js";

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a task is closed
 */
function isTaskClosed(taskId: string): boolean {
	try {
		const output = execSync(`bd show "${taskId}" --json`, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const data = JSON.parse(output || "[]");
		const task = Array.isArray(data) ? data[0] : data;

		if (!task) return true; // Not found = closed
		return task.status === "closed" || task.status === "done";
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(
				`[tiller patrol] isTaskClosed(${taskId}) error: ${(e as Error).message}`,
			);
		}
		return false; // Assume not closed on error
	}
}

/**
 * Check if we still own the task
 */
function ownsTask(taskId: string, mateName: string): boolean {
	try {
		const output = execSync(`bd show "${taskId}" --json`, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const data = JSON.parse(output || "[]");
		const task = Array.isArray(data) ? data[0] : data;

		if (!task) return false;
		return task.assignee === mateName;
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(
				`[tiller patrol] ownsTask(${taskId}, ${mateName}) error: ${(e as Error).message}`,
			);
		}
		return false;
	}
}

/**
 * Wait for task to be closed or ownership lost
 */
async function waitForTaskClosed(
	taskId: string,
	mateName: string,
	pollInterval: number = 2000,
	timeoutMs: number = 30 * 60 * 1000, // 30 minutes
): Promise<"closed" | "lost" | "timeout"> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		if (isTaskClosed(taskId)) {
			return "closed";
		}
		if (!ownsTask(taskId, mateName)) {
			return "lost";
		}
		await sleep(pollInterval);
	}

	return "timeout";
}

export function registerPatrolCommand(program: Command): void {
	program
		.command("patrol <mate-name>")
		.description("Claim a mate and patrol for work (unattended loop)")
		.option("--once", "Exit after completing one task")
		.option("--poll-interval <ms>", "Poll interval in milliseconds", "5000")
		.action(
			async (name: string, opts: { once?: boolean; pollInterval: string }) => {
				const pollInterval = parseInt(opts.pollInterval, 10);
				const once = opts.once ?? false;

				// Step 1: Get and claim mate
				const mate = getMate(name);
				if (!mate) {
					console.error(`Mate not found: ${name}`);
					console.error(`Create with: tiller mate add ${name}`);
					process.exit(1);
				}

				// Check if already claimed by another process
				if (mate.claimedBy && mate.claimedBy !== process.pid) {
					try {
						process.kill(mate.claimedBy, 0); // Check if alive
						console.error(`Mate ${name} is claimed by PID ${mate.claimedBy}`);
						process.exit(1);
					} catch (e) {
						// ESRCH = no such process (safe to reclaim)
						// EPERM = permission denied (process exists, can't signal it)
						const err = e as NodeJS.ErrnoException;
						if (err.code === "EPERM") {
							// Process exists but we can't signal it - don't reclaim
							console.error(
								`Mate ${name} is claimed by PID ${mate.claimedBy} (cannot verify - permission denied)`,
							);
							process.exit(1);
						}
						// ESRCH or other error - process is gone, safe to reclaim
						console.log(
							`Reclaiming stale mate (PID ${mate.claimedBy} is gone)`,
						);
					}
				}

				// Claim the mate
				const sessionId = getCurrentSession();
				updateMate(name, {
					state: "sailing",
					claimedBy: process.pid,
					claimedBySession: sessionId,
					claimedAt: new Date().toISOString(),
				});

				console.log(
					`[attached] Mate ${name} claimed by PID ${process.pid}${sessionId ? ` (session ${sessionId.slice(0, 8)}...)` : ""}`,
				);

				// Step 2: Set BD_ACTOR for beads audit trail
				process.env.BD_ACTOR = name;

				// Step 3: Set up clean shutdown
				let stopped = false;

				const cleanup = () => {
					if (stopped) return;
					stopped = true;
					console.log("\n[shutdown] Releasing mate...");
					updateMate(name, {
						state: "available",
						claimedBy: null,
						claimedBySession: null,
						claimedAt: null,
					});
					console.log(`[shutdown] Mate ${name} released`);
					process.exit(0);
				};

				process.on("SIGINT", cleanup);
				process.on("SIGTERM", cleanup);

				// Step 4: Patrol loop
				console.log("[patrol] Starting work loop...\n");

				while (!stopped) {
					// Find ready work
					const tasks = findReadyTasks({ unassigned: true, limit: 1 });

					if (tasks.length === 0) {
						console.log("[idle] No unblocked tasks available");
						await sleep(pollInterval);
						continue;
					}

					// Claim task
					const task = tasks[0];
					const result = claimTask(task.id, name);

					if (!result.success) {
						console.log(
							`[race] Lost claim: ${result.error} (owner: ${result.actual_owner})`,
						);
						await sleep(1000); // Brief backoff
						continue;
					}

					console.log(`[claimed] ${result.task_id}: ${result.task_title}`);

					// Output the task for the agent to work on
					console.log(`\n--- TASK START ---`);
					console.log(`ID: ${result.task_id}`);
					console.log(`Title: ${result.task_title}`);
					console.log(
						`--- Work on this task, then run: bd close ${result.task_id} ---\n`,
					);

					// Wait for task to be closed
					const waitResult = await waitForTaskClosed(
						result.task_id!,
						name,
						2000,
						30 * 60 * 1000,
					);

					if (waitResult === "closed") {
						console.log(`[complete] ${result.task_id}`);
					} else if (waitResult === "lost") {
						console.log(`[lost] Lost ownership of ${result.task_id}`);
					} else {
						console.log(
							`[timeout] Task ${result.task_id} timed out after 30 minutes`,
						);
					}

					if (once) {
						console.log("[once] Single task mode, exiting...");
						break;
					}
				}

				cleanup();
			},
		);
}
