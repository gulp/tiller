/**
 * Hand Registration
 *
 * Handles hand identity generation and registration with beads.
 */

import { execSync } from "node:child_process";
import type { Hand, HandState } from "./types.js";

/**
 * Generate a unique hand name
 */
export function generateHandName(): string {
	const timestamp = Date.now();
	const random = Math.random().toString(36).substring(2, 6);
	return `hand-${timestamp}-${random}`;
}

/**
 * Create and register a new hand
 */
export function createHand(name?: string): Hand {
	const handName = name || process.env.TILLER_HAND_NAME || generateHandName();
	const now = new Date().toISOString();

	const hand: Hand = {
		id: handName,
		name: handName,
		state: "spawning",
		current_task: null,
		spawned_at: now,
		last_heartbeat: now,
		tasks_completed: 0,
	};

	// Set environment for all subsequent bd commands
	process.env.BD_ACTOR = handName;

	// Try to create agent bead in beads (optional - for monitoring)
	try {
		execSync(
			`bd create --type=agent --title="${handName}" --role-type=polecat --silent 2>/dev/null || true`,
			{
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	} catch {
		// Ignore - agent bead is optional
	}

	// Set initial state
	try {
		execSync(`bd agent state "${handName}" spawning`, {
			encoding: "utf-8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		// Ignore
	}

	return hand;
}

/**
 * Update hand state
 */
export function setHandState(hand: Hand, state: HandState): Hand {
	hand.state = state;
	hand.last_heartbeat = new Date().toISOString();

	try {
		execSync(`bd agent state "${hand.name}" ${state}`, {
			encoding: "utf-8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		// Ignore
	}

	return hand;
}

/**
 * Set current task for hand (updates statusline env)
 */
export function setCurrentTask(hand: Hand, taskId: string | null): Hand {
	hand.current_task = taskId;
	hand.last_heartbeat = new Date().toISOString();

	if (taskId) {
		process.env.BD_STATUSLINE_TASK = taskId;
	} else {
		delete process.env.BD_STATUSLINE_TASK;
	}

	return hand;
}

/**
 * Record task completion
 */
export function recordCompletion(hand: Hand): Hand {
	hand.tasks_completed++;
	hand.current_task = null;
	hand.last_heartbeat = new Date().toISOString();
	delete process.env.BD_STATUSLINE_TASK;

	return hand;
}

/**
 * Clean shutdown of hand
 */
export function shutdownHand(hand: Hand): void {
	setHandState(hand, "stopped");
	delete process.env.BD_STATUSLINE_TASK;
}

/**
 * Get hand name from environment or generate new one
 */
export function getOrCreateHandName(): string {
	return (
		process.env.TILLER_HAND_NAME || process.env.BD_ACTOR || generateHandName()
	);
}
