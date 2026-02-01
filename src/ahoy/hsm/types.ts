/**
 * HSM (Hierarchical State Machine) types for ahoy planning workflows
 *
 * Uses slash notation for workflow/state hierarchy (agent-first design):
 * - Clear hierarchy, not property access
 * - Clean token boundaries
 * - Reads as path, not code
 */

// Workflow types
export type Workflow = "discussion" | "research" | "planning";

// State within each workflow (noun/verb convention)
export type DiscussionState = "idle" | "gathering" | "complete";
export type ResearchState = "idle" | "scoping" | "complete";
export type PlanningState =
	| "idle"
	| "discovery"
	| "loading"
	| "review"
	| "approved";

// Combined workflow/state type using slash notation (agent-first)
export type WorkflowState =
	| `discussion/${DiscussionState}`
	| `research/${ResearchState}`
	| `planning/${PlanningState}`;

// Session state stored per initiative/phase
export interface SessionState {
	initiative: string;
	phase: string;
	workflow: Workflow;
	state: string; // The substate within the workflow
	artifacts: {
		context: boolean; // CONTEXT.md exists
		research: boolean; // RESEARCH.md exists
		discovery: boolean; // DISCOVERY.md exists
		plans: string[]; // List of PLAN.md files
	};
	transitions: StateTransition[];
	updatedAt: string; // ISO timestamp
}

// Audit trail for state transitions
export interface StateTransition {
	from: WorkflowState;
	to: WorkflowState;
	timestamp: string;
	reason?: string;
}

// Valid state transitions map
const VALID_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
	"discussion/idle": ["discussion/gathering"],
	"discussion/gathering": ["discussion/complete"],
	"discussion/complete": [],
	"research/idle": ["research/scoping"],
	"research/scoping": ["research/complete"],
	"research/complete": [],
	"planning/idle": ["planning/discovery", "planning/loading"],
	"planning/discovery": ["planning/loading"],
	"planning/loading": ["planning/review"],
	"planning/review": ["planning/approved"],
	"planning/approved": [],
};

/**
 * Parse a workflow state string into its components
 */
export function parseWorkflowState(state: WorkflowState): {
	workflow: Workflow;
	substate: string;
} {
	const [workflow, substate] = state.split("/") as [Workflow, string];
	return { workflow, substate };
}

/**
 * Format workflow and substate into a combined state string
 */
export function formatWorkflowState(
	workflow: Workflow,
	substate: string,
): WorkflowState {
	const state = `${workflow}/${substate}` as WorkflowState;
	// Validate the combination is valid
	if (!isValidWorkflowState(state)) {
		throw new Error(
			`Invalid workflow state: ${state}. Substate "${substate}" is not valid for workflow "${workflow}"`,
		);
	}
	return state;
}

/**
 * Check if a string is a valid workflow state
 */
function isValidWorkflowState(state: string): state is WorkflowState {
	return state in VALID_TRANSITIONS;
}

/**
 * Check if a state transition is valid
 */
export function isValidTransition(
	from: WorkflowState,
	to: WorkflowState,
): boolean {
	const validTargets = VALID_TRANSITIONS[from];
	return validTargets?.includes(to) ?? false;
}

/**
 * Get all valid transitions from a given state
 */
export function getValidTransitions(from: WorkflowState): WorkflowState[] {
	return VALID_TRANSITIONS[from] ?? [];
}
