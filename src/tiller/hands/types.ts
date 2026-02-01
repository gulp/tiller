/**
 * Hand Types - Multi-agent worker coordination
 *
 * A "hand" is a worker agent spawned by tiller to execute tasks.
 * Hands self-organize to claim unblocked work from beads.
 */

/**
 * Hand identity and state
 */
export interface Hand {
	/** Unique hand identifier (e.g., "hand-1736956800-12345") */
	id: string;

	/** Human-readable name (e.g., "hand-alpha") */
	name: string;

	/** Current state */
	state: HandState;

	/** Currently claimed task ID (if any) */
	current_task: string | null;

	/** ISO timestamp when hand was spawned */
	spawned_at: string;

	/** ISO timestamp of last heartbeat */
	last_heartbeat: string;

	/** Number of tasks completed this session */
	tasks_completed: number;
}

/**
 * Hand lifecycle states
 */
export type HandState =
	| "spawning" // Starting up, registering
	| "idle" // Waiting for work
	| "claiming" // Attempting to claim a task
	| "working" // Actively working on a task
	| "completing" // Finishing up current task
	| "stopped" // Clean shutdown
	| "dead"; // Unclean termination (set by witness)

/**
 * Result of attempting to claim a task
 */
export interface ClaimResult {
	/** Whether the claim succeeded */
	success: boolean;

	/** Task ID if successful */
	task_id: string | null;

	/** Task title if successful */
	task_title: string | null;

	/** Reason for failure (if any) */
	error: string | null;

	/** Who actually owns the task (if we lost the race) */
	actual_owner: string | null;
}

/**
 * Options for spawning a hand
 */
export interface SpawnOptions {
	/** Hand name (auto-generated if not provided) */
	name?: string;

	/** Filter tasks by label */
	labels?: string[];

	/** Filter tasks by parent/epic */
	parent?: string;

	/** Maximum tasks to complete before stopping (0 = unlimited) */
	max_tasks?: number;

	/** Completion promise phrase to stop the loop */
	completion_promise?: string;
}

/**
 * Hand work loop configuration
 */
export interface WorkLoopConfig {
	/** Hand identity */
	hand: Hand;

	/** Task filter options */
	filter: TaskFilter;

	/** Maximum iterations (0 = unlimited) */
	max_iterations: number;

	/** Completion promise phrase */
	completion_promise: string | null;

	/** Callback when task is claimed */
	on_claim?: (task_id: string, title: string) => void;

	/** Callback when task is completed */
	on_complete?: (task_id: string) => void;

	/** Callback when no work is available */
	on_idle?: () => void;
}

/**
 * Filter for finding tasks
 */
export interface TaskFilter {
	/** Only unassigned tasks */
	unassigned: boolean;

	/** Filter by labels (AND) */
	labels?: string[];

	/** Filter by parent issue */
	parent?: string;

	/** Filter by priority */
	priority?: number;

	/** Maximum tasks to return */
	limit: number;
}

/**
 * Environment variables used by hands
 */
export const HAND_ENV = {
	/** Actor name for beads operations */
	BD_ACTOR: "BD_ACTOR",

	/** Current task ID for statusline */
	BD_STATUSLINE_TASK: "BD_STATUSLINE_TASK",

	/** Hand name (optional override) */
	TILLER_HAND_NAME: "TILLER_HAND_NAME",

	/** Session ID from Claude Code */
	CLAUDE_SESSION_ID: "CLAUDE_SESSION_ID",
} as const;
