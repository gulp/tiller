/**
 * Agent observability commands
 *
 * Commands: agent register, agent report, agent heartbeat, agent unregister, agents
 */

import type { Command } from "commander";
import {
	ensureAgentsDir,
	getAgentName,
	isAgentStale,
	listAgents,
	loadAgent,
	removeAgent,
	saveAgent,
} from "../state/agent.js";
import { logEvent } from "../state/events.js";
import type { AgentState, AgentStatus } from "../types/index.js";

export function registerAgentCommands(program: Command): void {
	const agent = program
		.command("agent")
		.description("Agent observability commands");

	// tiller agent register
	agent
		.command("register")
		.description("Register agent for observability (reads $TILLER_AGENT)")
		.action(async () => {
			ensureAgentsDir();
			const name = getAgentName();

			const existing = loadAgent(name);
			if (existing && !isAgentStale(existing)) {
				console.error(`Agent '${name}' already registered and active.`);
				console.error(`Last heartbeat: ${existing.heartbeat}`);
				process.exit(1);
			}

			const now = new Date().toISOString();
			const status: AgentStatus = {
				agent: name,
				state: "idle",
				run_id: null,
				current_task: null,
				message: null,
				registered: now,
				updated: now,
				heartbeat: now,
			};

			saveAgent(status);
			logEvent({ event: "agent_registered", agent: name });

			console.log(`✓ Agent registered: ${name}`);
			console.log(`  State: idle`);
			console.log(`  Ready to claim work with: tiller ready`);
		});

	// tiller agent report <state> [message]
	agent
		.command("report <state> [message]")
		.description("Report agent state (idle|working|stuck)")
		.action(async (state: string, message?: string) => {
			const validStates: AgentState[] = ["idle", "working", "stuck"];
			if (!validStates.includes(state as AgentState)) {
				console.error(
					`Invalid state: ${state}. Valid: ${validStates.join(", ")}`,
				);
				process.exit(1);
			}

			const name = getAgentName();
			const existing = loadAgent(name);

			if (!existing) {
				console.error(
					`Agent '${name}' not registered. Run: tiller agent register`,
				);
				process.exit(1);
			}

			const now = new Date().toISOString();
			existing.state = state as AgentState;
			existing.message = message || null;
			existing.updated = now;
			existing.heartbeat = now;

			saveAgent(existing);
			logEvent({ event: "agent_report", agent: name, state, message });

			console.log(
				`✓ Agent ${name}: ${state}${message ? ` - "${message}"` : ""}`,
			);
		});

	// tiller agent heartbeat
	agent
		.command("heartbeat")
		.description("Send heartbeat to prove liveness")
		.action(async () => {
			const name = getAgentName();
			const existing = loadAgent(name);

			if (!existing) {
				console.error(
					`Agent '${name}' not registered. Run: tiller agent register`,
				);
				process.exit(1);
			}

			const now = new Date().toISOString();
			existing.heartbeat = now;
			existing.updated = now;

			saveAgent(existing);
			// Don't log heartbeats to events (too noisy)

			console.log(`✓ Heartbeat: ${name} at ${now}`);
		});

	// tiller agent unregister
	agent
		.command("unregister")
		.description("Unregister agent (clean exit)")
		.action(async () => {
			const name = getAgentName();
			const existing = loadAgent(name);

			if (!existing) {
				console.log(`Agent '${name}' not registered.`);
				process.exit(0);
			}

			// Clear run claim if any
			if (existing.run_id) {
				console.log(`Note: Agent had claimed run ${existing.run_id}`);
				// Run claim release handled separately
			}

			await removeAgent(name);
			logEvent({ event: "agent_unregistered", agent: name });

			console.log(`✓ Agent unregistered: ${name}`);
		});

	// tiller agents (list all agents)
	program
		.command("agents")
		.description("List all registered agents")
		.option("--json", "Output as JSON")
		.action(async (options: { json?: boolean }) => {
			const agents = listAgents();

			// Mark stale agents
			const enriched = agents.map((a) => ({
				...a,
				stale: isAgentStale(a),
			}));

			if (options.json) {
				console.log(JSON.stringify(enriched, null, 2));
				return;
			}

			if (agents.length === 0) {
				console.log("No agents registered.");
				return;
			}

			console.log("AGENTS");
			console.log("─".repeat(70));
			console.log("  NAME          STATE      TRACK           MESSAGE");
			console.log("─".repeat(70));

			for (const a of enriched) {
				const staleMarker = a.stale ? " ⚠" : "";
				const track = a.run_id || "-";
				const msg = a.message ? `"${a.message.slice(0, 25)}..."` : "-";
				console.log(
					`  ${a.agent.padEnd(12)}  ${(a.state + staleMarker).padEnd(10)}  ${track.padEnd(14)}  ${msg}`,
				);
			}

			console.log("─".repeat(70));
			console.log(`Total: ${agents.length} agent(s)`);

			const staleCount = enriched.filter((a) => a.stale).length;
			if (staleCount > 0) {
				console.log(`
⚠ ${staleCount} stale agent(s) (no heartbeat >5min)`);
			}
		});
}
