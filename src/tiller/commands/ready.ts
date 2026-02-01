/**
 * tiller ready - Show actionable work
 *
 * Primary workflow command for discovering available runs.
 * Outputs TOON grouped by initiative for agent scannability.
 */

import type { Command } from "commander";
import { getRunPlanRef, isClaimExpired, listRuns } from "../state/run.js";
import { matchState } from "../types/index.js";
import { outputTOON } from "../types/toon.js";

export function registerReadyCommand(program: Command): void {
	program
		.command("ready")
		.description("Show actionable work (approved, ready, active runs)")
		.option("--json", "Output as JSON for agent consumption")
		.option("--pretty", "Human-readable formatted output")
		.option("--all", "Include blocked runs")
		.action((options: { json?: boolean; pretty?: boolean; all?: boolean }) => {
			const allRuns = listRuns();

			// Actionable states: approved (waiting to import), ready (waiting to start), active (in progress)
			const actionableStates = ["approved", "ready", "active"];
			const actionable = allRuns.filter((r) =>
				actionableStates.some((s) => matchState(r.state, s)),
			);

			// Build ready items with blocking info
			const items = actionable.map((r) => {
				const blockedBy = (r.depends_on ?? []).filter((depId) => {
					const dep = allRuns.find((x) => x.id === depId);
					return dep && dep.state !== "complete";
				});
				const claimed = Boolean(r.claimed_by && !isClaimExpired(r));

				return {
					planRef: getRunPlanRef(r),
					initiative: r.initiative ?? "unknown",
					intent: r.intent,
					state: r.state,
					priority: r.priority ?? 99,
					claimed,
					blocked: blockedBy.length > 0,
					blockedBy: blockedBy.map((id) => {
						const dep = allRuns.find((x) => x.id === id);
						return dep ? getRunPlanRef(dep) : id;
					}),
				};
			});

			// Filter blocked unless --all
			const filtered = options.all ? items : items.filter((i) => !i.blocked);

			// Sort by initiative (grouped), then priority, then state (active > ready > approved)
			const stateOrder: Record<string, number> = {
				active: 0,
				ready: 1,
				approved: 2,
			};
			filtered.sort((a, b) => {
				// Group by initiative first for scannability
				if (a.initiative !== b.initiative) {
					return a.initiative.localeCompare(b.initiative);
				}
				if (a.priority !== b.priority) return a.priority - b.priority;
				const aOrder = stateOrder[a.state.split("/")[0]] ?? 99;
				const bOrder = stateOrder[b.state.split("/")[0]] ?? 99;
				return aOrder - bOrder;
			});

			// Build ready data
			const blockedCount = items.filter((i) => i.blocked).length;
			const readyData = {
				items: filtered,
				count: filtered.length,
				blocked_count: blockedCount,
				include_blocked: options.all ?? false,
			};

			// JSON output (--json flag)
			if (options.json) {
				console.log(JSON.stringify(filtered, null, 2));
				return;
			}

			// Pretty output function for --pretty flag or TOON prettyFn
			const printPretty = () => {
				if (filtered.length === 0) {
					if (items.length > 0 && !options.all) {
						console.log(`No unblocked work. ${items.length} run(s) blocked.`);
						console.log("Run with --all to see blocked runs.");
					} else {
						console.log("No actionable work. Run tiller status for full view.");
					}
					return;
				}

				console.log(
					`Ready work (${filtered.length} run${filtered.length > 1 ? "s" : ""}):\n`,
				);

				for (const item of filtered) {
					// Format state concisely
					let stateStr: string = item.state;
					if (item.state.startsWith("active/")) {
						const sub = item.state.split("/")[1];
						stateStr = sub === "executing" ? "active" : `active/${sub}`;
					}

					const priorityStr = item.priority < 99 ? ` P${item.priority}` : "";
					const claimFlag = item.claimed ? " [claimed]" : "";
					const blockFlag = item.blocked
						? ` [blocked by: ${item.blockedBy.join(", ")}]`
						: "";

					console.log(
						`  ${item.planRef} (${stateStr}${priorityStr}): ${item.intent}${claimFlag}${blockFlag}`,
					);
				}

				// Show next action hint
				const first = filtered[0];
				if (first) {
					console.log("");
					if (first.state === "approved") {
						console.log(`Next: tiller import ${first.planRef}`);
					} else if (first.state === "ready") {
						console.log(`Next: tiller activate ${first.planRef}`);
					} else if (matchState(first.state, "active")) {
						console.log(`Next: Continue work on ${first.planRef}`);
					}
					console.log(`\nSee all runs: tiller status`);
				}
			};

			// Pretty output (--pretty flag)
			if (options.pretty) {
				printPretty();
				return;
			}

			// Default: TOON output with agent_hint
			const activeCount = filtered.filter((i) =>
				i.state.startsWith("active"),
			).length;
			const readyCount = filtered.filter((i) => i.state === "ready").length;
			const approvedCount = filtered.filter(
				(i) => i.state === "approved",
			).length;
			const parts = [];
			if (activeCount > 0) parts.push(`${activeCount} active`);
			if (readyCount > 0) parts.push(`${readyCount} ready`);
			if (approvedCount > 0) parts.push(`${approvedCount} approved`);
			const summary = parts.join(", ") || "none";

			let agentHint = `Present actionable runs. Lead: "${filtered.length} runs: ${summary}".`;
			agentHint += ` Data is grouped by initiative. Show as table: Initiative | Ref | State | Intent.`;

			outputTOON(
				{ ready: readyData },
				{
					agent_hint: agentHint,
					prettyFn: printPretty,
				},
			);
		});
}
