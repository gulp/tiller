/**
 * Agent state management for observability
 *
 * Agents register themselves and report status for multi-agent coordination.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentState, AgentStatus } from "../types/index.js";
import { PATHS } from "./config.js";

const AGENTS_DIR = PATHS.AGENTS_DIR;

/**
 * Ensure agents directory exists
 */
export function ensureAgentsDir(): void {
	if (!existsSync(AGENTS_DIR)) {
		mkdirSync(AGENTS_DIR, { recursive: true });
	}
}

/**
 * Get agent name from environment
 */
export function getAgentName(): string {
	const name = process.env.TILLER_AGENT;
	if (!name) {
		throw new Error(
			"TILLER_AGENT environment variable not set. Run: export TILLER_AGENT=<name>",
		);
	}
	return name;
}

/**
 * Load agent status
 */
export function loadAgent(name: string): AgentStatus | null {
	const path = join(AGENTS_DIR, `${name}.status.json`);
	if (!existsSync(path)) return null;

	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Save agent status
 */
export function saveAgent(status: AgentStatus): void {
	ensureAgentsDir();
	const path = join(AGENTS_DIR, `${status.agent}.status.json`);
	writeFileSync(path, JSON.stringify(status, null, 2));
}

/**
 * List all agents
 */
export function listAgents(): AgentStatus[] {
	ensureAgentsDir();

	if (!existsSync(AGENTS_DIR)) {
		return [];
	}

	const files = readdirSync(AGENTS_DIR).filter((f) =>
		f.endsWith(".status.json"),
	);
	const agents: AgentStatus[] = [];

	for (const file of files) {
		try {
			const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
			agents.push(JSON.parse(content));
		} catch {
			// Skip invalid files
		}
	}

	return agents;
}

/**
 * Remove agent (on clean exit)
 */
export async function removeAgent(name: string): Promise<void> {
	const path = join(AGENTS_DIR, `${name}.status.json`);
	if (existsSync(path)) {
		unlinkSync(path);
	}
}

/**
 * Check if agent heartbeat is stale (default: >5 minutes)
 */
export function isAgentStale(
	status: AgentStatus,
	thresholdMinutes = 5,
): boolean {
	const lastHeartbeat = new Date(status.heartbeat);
	const now = new Date();
	const diffMs = now.getTime() - lastHeartbeat.getTime();
	return diffMs > thresholdMinutes * 60 * 1000;
}

/**
 * Update agent state
 */
export function updateAgentState(
	name: string,
	state: AgentState,
	message?: string | null,
): AgentStatus | null {
	const existing = loadAgent(name);
	if (!existing) return null;

	const now = new Date().toISOString();
	existing.state = state;
	existing.message = message ?? existing.message;
	existing.updated = now;
	existing.heartbeat = now;

	saveAgent(existing);
	return existing;
}

/**
 * Link agent to run (when claiming)
 */
export function linkAgentToRun(
	name: string,
	runId: string | null,
): AgentStatus | null {
	const existing = loadAgent(name);
	if (!existing) return null;

	const now = new Date().toISOString();
	existing.run_id = runId;
	existing.state = runId ? "working" : "idle";
	existing.message = runId ? `Claimed ${runId}` : null;
	existing.updated = now;
	existing.heartbeat = now;

	saveAgent(existing);
	return existing;
}
