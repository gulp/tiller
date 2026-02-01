/**
 * Session storage utilities for ahoy HSM
 *
 * Stores session state per initiative/phase at .ahoy/sessions/{initiative}/{phase}.json
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	SessionState,
	StateTransition,
	Workflow,
	WorkflowState,
} from "./types.js";
import { isValidTransition, parseWorkflowState } from "./types.js";

/**
 * Get the path to a session file
 */
export function getSessionPath(
	initiative: string,
	phase: string,
	cwd: string = process.cwd(),
): string {
	return join(cwd, ".ahoy", "sessions", initiative, `${phase}.json`);
}

/**
 * Create an initial session state for an initiative/phase
 */
export function createInitialSession(
	initiative: string,
	phase: string,
	workflow: Workflow = "planning",
): SessionState {
	return {
		initiative,
		phase,
		workflow,
		state: "idle",
		artifacts: {
			context: false,
			research: false,
			discovery: false,
			plans: [],
		},
		transitions: [],
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Check if a session exists
 */
export function sessionExists(
	initiative: string,
	phase: string,
	cwd: string = process.cwd(),
): boolean {
	const path = getSessionPath(initiative, phase, cwd);
	return existsSync(path);
}

/**
 * Read session state (returns null if doesn't exist)
 */
export async function readSession(
	initiative: string,
	phase: string,
	cwd: string = process.cwd(),
): Promise<SessionState | null> {
	const path = getSessionPath(initiative, phase, cwd);

	if (!existsSync(path)) {
		return null;
	}

	try {
		const content = await readFile(path, "utf-8");
		return JSON.parse(content) as SessionState;
	} catch (error) {
		throw new Error(
			`Failed to read session for ${initiative}/${phase}: ${error}`,
		);
	}
}

/**
 * Write session state (creates directories if needed)
 */
export async function writeSession(
	session: SessionState,
	cwd: string = process.cwd(),
): Promise<void> {
	const path = getSessionPath(session.initiative, session.phase, cwd);
	const dir = dirname(path);

	// Ensure directory exists
	if (!existsSync(dir)) {
		await mkdir(dir, { recursive: true });
	}

	// Update timestamp
	session.updatedAt = new Date().toISOString();

	// Write with pretty formatting for human readability
	await writeFile(path, JSON.stringify(session, null, 2));
}

/**
 * Transition session to a new state with validation and audit logging
 */
export async function transitionState(
	initiative: string,
	phase: string,
	to: WorkflowState,
	reason?: string,
	cwd: string = process.cwd(),
): Promise<SessionState> {
	// Read existing session or create new one
	let session = await readSession(initiative, phase, cwd);

	if (!session) {
		// Initialize new session with the target workflow
		const { workflow } = parseWorkflowState(to);
		session = createInitialSession(initiative, phase, workflow);
	}

	// Build current state
	const from = `${session.workflow}/${session.state}` as WorkflowState;

	// Validate transition
	if (!isValidTransition(from, to)) {
		throw new Error(
			`Invalid state transition: ${from} → ${to}. ` +
				`Check valid transitions for the ${session.workflow} workflow.`,
		);
	}

	// Parse target state
	const { workflow: toWorkflow, substate: toSubstate } = parseWorkflowState(to);

	// Create transition record
	const transition: StateTransition = {
		from,
		to,
		timestamp: new Date().toISOString(),
		reason,
	};

	// Update session
	session.workflow = toWorkflow;
	session.state = toSubstate;
	session.transitions.push(transition);

	// Save session
	await writeSession(session, cwd);

	return session;
}

/**
 * Get or create a session for an initiative/phase
 */
export async function getOrCreateSession(
	initiative: string,
	phase: string,
	workflow: Workflow = "planning",
	cwd: string = process.cwd(),
): Promise<SessionState> {
	const existing = await readSession(initiative, phase, cwd);
	if (existing) {
		return existing;
	}

	const session = createInitialSession(initiative, phase, workflow);
	await writeSession(session, cwd);
	return session;
}

/**
 * Update session artifacts (e.g., when files are created/discovered)
 */
export async function updateSessionArtifacts(
	initiative: string,
	phase: string,
	artifacts: Partial<SessionState["artifacts"]>,
	cwd: string = process.cwd(),
): Promise<SessionState> {
	const session = await readSession(initiative, phase, cwd);
	if (!session) {
		throw new Error(`No session found for ${initiative}/${phase}`);
	}

	// Merge artifacts
	session.artifacts = {
		...session.artifacts,
		...artifacts,
	};

	await writeSession(session, cwd);
	return session;
}

/**
 * List all sessions for an initiative
 */
export async function listInitiativeSessions(
	initiative: string,
	cwd: string = process.cwd(),
): Promise<string[]> {
	const dir = join(cwd, ".ahoy", "sessions", initiative);

	if (!existsSync(dir)) {
		return [];
	}

	const { readdirSync } = await import("node:fs");
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	return files.map((f) => f.replace(".json", ""));
}
