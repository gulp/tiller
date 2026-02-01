/**
 * Workflow Type Definitions
 *
 * Types for GSD workflow definitions. Workflows use two formats:
 * - TOML: Human-editable workflow definitions (stored in .tiller/workflows/)
 * - TOON: Token-Optimized Notation for runtime context injection (compact state format)
 *
 * The workflow engine extracts DAGs from GSD commands, making step routing
 * deterministic and CLI-routable instead of prose-inferred.
 */

/**
 * Condition expression node for evaluating step transitions.
 *
 * Supported operators:
 * - exists(key): true if state has key with non-null value
 * - eq(key, value): true if state[key] === value
 * - contains(key, value): true if state[key] is array and includes value
 * - and(cond1, cond2): both conditions true
 * - or(cond1, cond2): either condition true
 * - not(cond): negation
 * - literal true/false
 */
export type ConditionNode =
	| { type: "exists"; key: string }
	| { type: "eq"; key: string; value: string }
	| { type: "contains"; key: string; value: string }
	| { type: "and"; left: ConditionNode; right: ConditionNode }
	| { type: "or"; left: ConditionNode; right: ConditionNode }
	| { type: "not"; operand: ConditionNode }
	| { type: "literal"; value: boolean };

/**
 * Edge connecting one step to another with optional condition.
 *
 * @example
 * // Default edge (always taken if no other condition matches)
 * { target: "next-step", condition: null }
 *
 * // Conditional edge
 * { target: "error-handling", condition: "exists(error)", label: "On error" }
 */
export interface StepEdge {
	/** Target step ID */
	target: string;

	/**
	 * Condition expression string or null for default edge.
	 * Evaluated against workflow instance state.
	 * Null condition = default edge (taken if no other conditions match).
	 */
	condition: string | null;

	/** Optional human-readable label describing why this edge is taken */
	label?: string;
}

/**
 * Single step in a workflow DAG.
 *
 * Steps contain:
 * - Identity: id and name
 * - Instructions: description (prose for agent to execute)
 * - Outputs: state keys this step can produce
 * - Transitions: edges to other steps based on conditions
 */
export interface WorkflowStep {
	/** Unique identifier within the workflow (e.g., "gather-requirements") */
	id: string;

	/** Human-readable step name (e.g., "Gather Requirements") */
	name: string;

	/**
	 * Prose instructions for the agent executing this step.
	 * This is what Claude reads to understand what to do.
	 * Preserved from original GSD command workflow descriptions.
	 */
	description?: string;

	/**
	 * State keys this step can produce.
	 * Used to document expected outputs and enable dependency tracking.
	 * @example ["requirements_gathered", "key_requirements"]
	 */
	outputs?: string[];

	/**
	 * Transitions to other steps.
	 * Evaluated in order; first matching condition wins.
	 * Should include exactly one default edge (condition: null) as fallback.
	 */
	next: StepEdge[];
}

/**
 * Complete workflow definition.
 *
 * Workflows are DAGs extracted from GSD commands, stored as TOML files.
 * They make GSD command execution deterministic and resumable:
 * - CLI tracks step position
 * - Agent queries "where am I?" via `tiller workflow status`
 * - Agent advances via `tiller step done`
 */
export interface WorkflowDefinition {
	/** Workflow name (e.g., "new-project", "plan-phase") */
	name: string;

	/** Semantic version (e.g., "1.0") */
	version: string;

	/** Human-readable description of what this workflow accomplishes */
	description: string;

	/** All steps in this workflow */
	steps: WorkflowStep[];

	/** ID of the initial step (entry point) */
	initial_step: string;

	/** IDs of terminal steps (workflow ends when reaching these) */
	terminal_steps: string[];
}

/**
 * Runtime state of a workflow instance.
 *
 * Created when starting a workflow, persisted across sessions.
 * TOON format serializes this for token-efficient context injection.
 */
export interface WorkflowInstance {
	/** Unique instance identifier (e.g., "new-project-1736956800") */
	id: string;

	/** Name of the workflow definition */
	workflow_name: string;

	/** Current step ID */
	current_step: string;

	/** Accumulated state from step outputs */
	state: Record<string, unknown>;

	/** History of visited step IDs */
	history: string[];

	/** ISO timestamp when workflow started */
	started_at: string;

	/** ISO timestamp of last update */
	updated_at: string;
}

/**
 * Result of evaluating next steps from current position.
 */
export interface NextStep {
	/** Target step ID */
	step_id: string;

	/** Human-readable step name */
	step_name: string;

	/** Condition expression (null = default) */
	condition: string | null;

	/** Whether the condition is currently satisfied */
	condition_met: boolean;

	/** Whether this is the default edge */
	is_default: boolean;
}

/**
 * Valid condition operator names.
 */
export type ConditionOperator =
	| "exists"
	| "eq"
	| "contains"
	| "and"
	| "or"
	| "not";

/**
 * Error from workflow validation.
 */
export interface WorkflowValidationError {
	/** Error type (e.g., "invalid_step", "unreachable_step") */
	type: string;

	/** Human-readable error message */
	message: string;

	/** Path to the invalid field (e.g., "steps.foo.next[0].target") */
	path?: string;

	/** Related step ID, if applicable */
	step_id?: string;

	/** Related edge target, if applicable */
	edge_target?: string;
}

/**
 * Result of validating a workflow definition.
 */
export interface WorkflowValidationResult {
	/** Whether the workflow is valid */
	valid: boolean;

	/** List of validation errors */
	errors: WorkflowValidationError[];

	/** List of warnings (non-fatal issues) */
	warnings: WorkflowValidationError[];
}

/**
 * Parsed TOON state for runtime injection.
 */
export interface ParsedToonState {
	/** Workflow name */
	workflow: string;

	/** Current step ID */
	step: string;

	/** State key-value pairs */
	state: Record<string, unknown>;

	/** Step history */
	history: string[];

	/** Available next steps */
	next: Array<{
		step: string;
		condition: string | null;
	}>;
}
