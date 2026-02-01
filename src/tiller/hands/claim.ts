/**
 * Atomic Task Claiming
 *
 * Provides race-safe task claiming for multi-agent coordination.
 * Uses bd update --claim + verification pattern.
 */

import { execSync } from "node:child_process";
import type { ClaimResult, TaskFilter } from "./types.js";

/**
 * Find ready tasks that match the filter
 */
export function findReadyTasks(
	filter: TaskFilter,
): Array<{ id: string; title: string }> {
	const args = ["bd", "ready", "--json"];

	if (filter.unassigned) {
		args.push("--unassigned");
	}
	if (filter.labels?.length) {
		for (const label of filter.labels) {
			args.push("--label", label);
		}
	}
	if (filter.parent) {
		args.push("--parent", filter.parent);
	}
	if (filter.priority !== undefined) {
		args.push("--priority", String(filter.priority));
	}
	args.push("--limit", String(filter.limit));

	try {
		const output = execSync(args.join(" "), {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const tasks = JSON.parse(output || "[]");
		return tasks.map((t: { id: string; title: string }) => ({
			id: t.id,
			title: t.title,
		}));
	} catch {
		return [];
	}
}

/**
 * Attempt to atomically claim a task.
 *
 * Uses bd update --claim which fails if already claimed,
 * then verifies ownership to handle race conditions.
 */
export function claimTask(taskId: string, handName: string): ClaimResult {
	// Step 1: Attempt atomic claim
	try {
		execSync(`BD_ACTOR="${handName}" bd update "${taskId}" --claim`, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, BD_ACTOR: handName },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// Check if it's an "already claimed" error
		if (message.includes("already claimed")) {
			const match = message.match(/already claimed by (\S+)/);
			return {
				success: false,
				task_id: null,
				task_title: null,
				error: "already_claimed",
				actual_owner: match?.[1] || "unknown",
			};
		}

		return {
			success: false,
			task_id: null,
			task_title: null,
			error: message,
			actual_owner: null,
		};
	}

	// Step 2: Verify we actually own it (race condition check)
	try {
		const output = execSync(`bd show "${taskId}" --json`, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const tasks = JSON.parse(output || "[]");
		const task = tasks[0];

		if (!task) {
			return {
				success: false,
				task_id: null,
				task_title: null,
				error: "task_not_found",
				actual_owner: null,
			};
		}

		if (task.assignee === handName) {
			// We own it!
			return {
				success: true,
				task_id: task.id,
				task_title: task.title,
				error: null,
				actual_owner: handName,
			};
		} else {
			// Lost the race - someone else got it
			return {
				success: false,
				task_id: null,
				task_title: null,
				error: "lost_race",
				actual_owner: task.assignee || "unknown",
			};
		}
	} catch (error) {
		return {
			success: false,
			task_id: null,
			task_title: null,
			error: error instanceof Error ? error.message : String(error),
			actual_owner: null,
		};
	}
}

/**
 * Close a completed task
 */
export function closeTask(taskId: string): boolean {
	try {
		execSync(`bd close "${taskId}"`, {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Update hand state in beads agent system
 */
export function updateHandState(
	handName: string,
	state: "spawning" | "idle" | "working" | "done" | "stopped",
): void {
	try {
		execSync(`bd agent state "${handName}" ${state}`, {
			encoding: "utf-8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		// Ignore errors - agent bead may not exist
	}
}

/**
 * Send heartbeat for hand
 */
export function heartbeat(handName: string): void {
	try {
		execSync(`bd agent heartbeat "${handName}"`, {
			encoding: "utf-8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		// Ignore errors
	}
}
