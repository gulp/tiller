/**
 * Tiller type definitions
 *
 * Based on TILLER-DESIGN.md + multi-track extensions from 02-RESEARCH.md
 */

// ============================================
// Hierarchical State Machine (HSM) - Slash Notation
// Agent-first design: slashes not dots for clear hierarchy
// ============================================

// Parent states (top-level)
export type ParentState =
	| "proposed"
	| "approved"
	| "ready"
	| "active"
	| "verifying"
	| "complete"
	| "abandoned";

// Active substates
export type ActiveSubstate = "executing" | "paused" | "checkpoint";

// Verifying substates (fix workflow loop)
export type VerifyingSubstate =
	| "testing"
	| "passed"
	| "failed"
	| "fixing"
	| "retesting";

// Full hierarchical state (slash notation for agent clarity)
export type RunState =
	| "proposed" // Plan created, awaiting human review
	| "approved" // Human approved intent, ready for import
	| "ready" // BD issues created, ready to execute
	| `active/${ActiveSubstate}` // Execution in progress
	| `verifying/${VerifyingSubstate}` // Verification workflow
	| "complete" // All done, SUMMARY.md written
	| "abandoned"; // Cancelled

// ADR-0004: Semantic aliases for plan vs run states
export type PlanState = "proposed" | "approved" | "ready";

// Check if state requires an active run (ADR-0004 invariant)
export function isRunState(state: RunState): boolean {
	return (
		state.startsWith("active/") ||
		state.startsWith("verifying/") ||
		state === "complete"
	);
}

// Parse state into parent and optional substate
export function parseState(state: RunState): {
	parent: ParentState;
	sub: string | null;
} {
	const parts = state.split("/");
	return {
		parent: parts[0] as ParentState,
		sub: parts[1] ?? null,
	};
}

// Valid state query patterns for --state flag
const VALID_STATE_QUERIES = [
	// Parent states (most common)
	"ready",
	"active",
	"active/*",
	"verifying",
	"verifying/*",
	"complete",
	"abandoned",
	// Specific substates
	"active/executing",
	"active/paused",
	"active/checkpoint",
	"verifying/testing",
	"verifying/passed",
	"verifying/failed",
	"verifying/fixing",
	"verifying/retesting",
	// Rarely used (tiller init only)
	"proposed",
	"approved",
] as const;

export type StateQuery = (typeof VALID_STATE_QUERIES)[number];

// Validate a state query string
export function isValidStateQuery(query: string): query is StateQuery {
	return VALID_STATE_QUERIES.includes(query as StateQuery);
}

// Get valid state queries for help text
export function getValidStateQueries(): readonly string[] {
	return VALID_STATE_QUERIES;
}

// Get formatted state help for error messages (derived from VALID_STATE_QUERIES)
export function getStateHelpText(): string {
	const states = VALID_STATE_QUERIES.filter(s => !s.includes("/"));
	const substates = VALID_STATE_QUERIES.filter(s => s.includes("/") && !s.endsWith("/*"));
	const wildcards = VALID_STATE_QUERIES.filter(s => s.endsWith("/*"));

	return `States:    ${states.join(", ")}
Substates: ${substates.join(", ")}
Wildcards: ${wildcards.join(", ")}`;
}

// Check if state matches query (supports wildcards)
// "verifying/*" matches verifying/testing, verifying/failed, etc.
// "verifying" matches any verifying/* substate
export function matchState(state: RunState, query: string): boolean {
	if (query.endsWith("/*")) {
		const parent = query.slice(0, -2);
		return state.startsWith(`${parent}/`) || state === parent;
	}
	if (!query.includes("/")) {
		// Parent-only query matches parent and all substates
		return state === query || state.startsWith(`${query}/`);
	}
	return state === query;
}

// Get display state (collapsed or expanded)
export function displayState(state: RunState, expand = false): string {
	if (expand) return state;
	const { parent } = parseState(state);
	return parent;
}

// State transition record
export interface Transition {
	from: RunState;
	to: RunState;
	at: string; // ISO timestamp
	by: "human" | "agent";
	reason?: string; // Optional reason for transition (e.g., abandon reason)
}

// Checkpoint types
export type CheckpointType = "human-verify" | "decision" | "human-action";

// Checkpoint option for decision type
export interface CheckpointOption {
	id: string;
	label: string;
	description?: string;
}

// Checkpoint from PLAN.md
export interface Checkpoint {
	id: string;
	type: CheckpointType;
	prompt: string;
	options?: CheckpointOption[]; // For decision type
	resolved: string | null; // null = pending, string = resolution
	resolved_at?: string;
}

// Beads task (read-only from bd)
export interface BeadsTask {
	id: string;
	title: string;
	status: "open" | "in_progress" | "closed";
}

// Beads snapshot (read-only from bd)
export interface BeadsSnapshot {
	synced_at: string;
	epic_id: string | null;
	tasks: BeadsTask[];
	progress: {
		closed: number;
		open: number;
		in_progress: number;
	};
	blocked: string[];
}

// Core Run type (renamed from Track per ADR-0004)
// Represents a single execution attempt of a PLAN
export interface Run {
	id: string; // Serialized as 'run_id' in JSON (accepts 'id'/'run_id' on load)
	initiative: string | null; // Initiative name, null for legacy runs
	intent: string;
	state: RunState;
	plan_path: string;
	created: string;
	updated: string;
	transitions: Transition[];
	checkpoints: Checkpoint[];

	// BD integration: issue references (set during import)
	beads_epic_id: string | null; // Phase epic in BD
	beads_task_id: string | null; // Plan task in BD
	beads_snapshot: BeadsSnapshot | null; // Task progress snapshot

	// Multi-run: Agent claiming (prevents concurrent work on same run)
	claimed_by: string | null; // Agent/session ID or null if unclaimed
	claimed_at: string | null; // ISO timestamp when claimed
	claim_expires: string | null; // ISO timestamp for auto-release (default: 30min)

	// Multi-run: Conflict detection (file overlap between runs)
	files_touched: string[]; // From PLAN.md files_modified frontmatter

	// Multi-run: Work ordering
	priority: number; // 0 = highest, default 99
	depends_on: string[]; // Other run IDs that must complete first

	// Verification results (from tiller verify / tiller uat)
	verification?: VerificationResults;

	// Completion metadata (set by tiller complete)
	completion?: CompletionRecord;

	// ============================================
	// Version metadata (08-10: monotonic versioned state)
	// Prefixed with _ to indicate derived/internal - NOT persisted to JSON
	// ============================================

	/** File mtime at read time - OPTIMISTIC LOCK TOKEN, not truth.
	 *  Caveat: mtime granularity is filesystem-dependent (ext4: ns, HFS+: 1s, FAT32: 2s).
	 *  "No change detected" means "no change observable at filesystem granularity". */
	_version?: string;

	/** Timestamp when this run was loaded into memory */
	_read_at?: string;
}

// ============================================
// Verification types (03.1-01-PLAN)
// ============================================

// Verification check result (legacy format - kept for backward compatibility)
export interface VerificationCheck {
	name: string; // e.g., "npm run build"
	command: string; // actual command run
	status: "pass" | "fail" | "skip";
	output?: string; // truncated stdout/stderr (max 500 chars)
	ran_at: string; // ISO timestamp
}

// ============================================
// Event-sourced verification types (08-03-PLAN)
// Append-only events → derived checks at read-time
// ============================================

// Verification event types (append-only log)
export type VerificationEvent =
	| VerificationRunStartedEvent
	| VerificationCheckExecutedEvent
	| VerificationManualRecordedEvent;

export interface VerificationRunStartedEvent {
	type: "run_started";
	at: string; // ISO timestamp
	by: "agent" | "human";
	checks_planned: string[]; // names in PLAN order
}

export interface VerificationCheckExecutedEvent {
	type: "check_executed";
	name: string;
	status: "pass" | "fail" | "error";
	exit_code: number | null; // null if couldn't exec
	output_tail: string; // truncated stdout+stderr (50 lines or 4KB)
	at: string; // ISO timestamp
	by: "agent";
}

export interface VerificationManualRecordedEvent {
	type: "manual_recorded";
	name: string;
	status: "pass" | "fail";
	reason?: string;
	at: string; // ISO timestamp
	by: "agent" | "human";
}

// Derived check (computed at read-time from events)
export interface DerivedCheck {
	name: string;
	kind: "cmd" | "manual";
	status: "pending" | "pass" | "fail" | "error";
	exit_code?: number;
	output_tail?: string;
	timeout?: number;
	updated_at?: string;
	by?: "agent" | "human";
	reason?: string;
}

// Event-sourced verification snapshot (derived at read-time)
export interface VerificationSnapshot {
	events: VerificationEvent[]; // append-only, source of truth
	checks: DerivedCheck[]; // derived at read-time
	manual_pending: boolean; // derived: any manual check with status = pending
}

// Check definition from PLAN.md <verification> section (YAML or prose)
export interface VerificationCheckDef {
	name: string;
	cmd?: string;
	manual?: boolean;
	timeout?: number; // seconds, default 120
	description?: string; // prose description for agent interpretation
}

// Verification results (both automated and UAT)
export interface VerificationResults {
	// Legacy format (for backward compatibility)
	automated?: {
		checks: VerificationCheck[];
		status: "pass" | "fail" | "pending";
		ran_at: string;
	};
	uat?: {
		checks: VerificationCheck[];
		status: "pass" | "fail" | "pending";
		ran_at: string;
		issues_logged: number;
	};
	// Event-sourced format (new)
	events?: VerificationEvent[];
}

// Completion record (set by tiller complete)
export interface CompletionRecord {
	timestamp: string; // ISO timestamp
	verification: {
		passed: boolean; // true if verifying/passed
		skipped: boolean; // true if --skip-verify used
		issues_resolved?: number; // count of resolved UAT issues
	};
	duration_minutes?: number; // time from active/executing to complete
	reason?: string; // optional audit trail for why completed
}

// Tiller config (from .tiller/tiller.toml)
export interface TillerConfig {
	version: string;
	paths: {
		plans: string;
		specs: string;
		default_initiative: string;
		todos: string;
	};
	sync: {
		auto_sync_on_status: boolean;
	};
	workflow: {
		confirmation_prompts: boolean;
		working_initiative?: string; // Selected initiative (mutable app state)
		/** @deprecated Use working_initiative instead */
		current_initiative?: string;
	};
	// Legacy fields (deprecated, for migration)
	default_plan_dir?: string;
	beads_cmd?: string;
	auto_sync_on_status?: boolean;
	confirmation_prompts?: boolean;
}

// Event log entry
export interface TillerEvent {
	ts: string;
	event: string;
	track?: string;
	from?: string;
	to?: string;
	plan?: string;
	epic?: string;
	progress?: string;
	agent?: string;
	[key: string]: unknown;
}

// Valid state transitions (HSM with slash notation)
// See docs/GSD-TILLER-MAPPING.md for full state machine diagram
export const VALID_TRANSITIONS: Record<string, RunState[]> = {
	// Top-level transitions
	proposed: ["approved", "abandoned"],
	approved: ["ready", "abandoned"],
	ready: ["active/executing", "abandoned"],

	// Active substates
	"active/executing": [
		"active/paused",
		"active/checkpoint",
		"verifying/testing",
		"abandoned",
	],
	"active/paused": ["active/executing", "abandoned"],
	"active/checkpoint": ["active/executing"],

	// Verifying substates (fix workflow loop)
	// All verifying substates can rework → active/executing
	"verifying/testing": [
		"verifying/passed",
		"verifying/failed",
		"active/executing",
	],
	"verifying/passed": ["complete", "active/executing"],
	"verifying/failed": ["verifying/fixing", "active/executing"],
	"verifying/fixing": ["verifying/retesting", "active/executing"],
	"verifying/retesting": [
		"verifying/passed",
		"verifying/failed",
		"active/executing",
	], // Loop back

	// Terminal states (complete allows rework back to active)
	complete: ["active/executing"],
	abandoned: [],
};

// Check if state transition is valid (handles both exact and parent-level)
export function canTransition(from: RunState, to: RunState): boolean {
	// Try exact match first
	if (VALID_TRANSITIONS[from]?.includes(to)) return true;

	// Try parent-level match
	const { parent: fromParent } = parseState(from);
	if (VALID_TRANSITIONS[fromParent]?.includes(to)) return true;

	return false;
}

// Ready run info for tiller ready command
export interface ReadyRun extends Run {
	conflicts_with: string[]; // Run IDs with file conflicts
	can_claim: boolean;
}

// ============================================
// Agent observability types (02-05-PLAN)
// ============================================

// Agent states (simpler than BD - focused on observability)
export type AgentState = "idle" | "working" | "stuck" | "offline";

// Agent status record
export interface AgentStatus {
	agent: string; // Agent name from $TILLER_AGENT
	state: AgentState;
	run_id: string | null; // Current run or null
	current_task: string | null; // Current task description
	message: string | null; // Human-readable status message
	registered: string; // ISO timestamp when registered
	updated: string; // ISO timestamp of last update
	heartbeat: string; // ISO timestamp of last heartbeat
}

// Agent status file location
/** @deprecated Use PATHS.AGENTS_DIR from state/config.js instead */
export const AGENTS_DIR = ".tiller/agents";

// Tiller status output
export interface TillerStatus {
	runs: {
		proposed: Run[];
		approved: Run[];
		ready: Run[];
		active: Run[];
		paused: Run[];
		checkpoint: Run[];
		verifying: Run[];
	};
	ready_runs: ReadyRun[];
	next_action:
		| "plan"
		| "approve"
		| "import"
		| "activate"
		| "execute"
		| "decide"
		| "verify"
		| "complete"
		| "none";
	suggested_run: string | null;
	suggested_action: string | null;
}
