/**
 * Tiller query commands - State visibility and work discovery
 *
 * Commands:
 * - status      Show tiller status and next action
 * - list        List runs with optional state filter
 * - show        Show detailed run info
 *
 * Note: `ready` command moved to ready.ts as first-class workflow command
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { isAgentStale, listAgents } from "../state/agent.js";
import { getWorkingInitiative, resolvePhasesDir } from "../state/initiative.js";
import { getTillerRedirectInfo, readPlanFile } from "../state/paths.js";
import { parseInitiativeRef } from "../utils/ref.js";
import { findAutopassSummaryPath } from "../verification/summary.js";
import {
	getRunPlanRef,
	isClaimExpired,
	listRuns,
	loadRun,
	loadRunVersioned,
	resolveRunRef,
	StaleReadError,
} from "../state/run.js";
import type { Run } from "../types/index.js";
import { getStateHelpText, isRunState, isValidStateQuery, matchState } from "../types/index.js";
import { outputTOON } from "../types/toon.js";

// Helper functions
function truncate(s: string, len: number): string {
	return s.length > len ? `${s.slice(0, len - 3)}...` : s;
}

function progressBar(pct: number, width: number): string {
	const filled = Math.round((pct / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function summarizeTrack(t: Run) {
	return {
		plan_ref: getRunPlanRef(t), // Primary identifier (human-friendly)
		id: t.id, // Internal track ID (for debugging)
		intent: t.intent,
		state: t.state,
		plan_path: t.plan_path,
		priority: t.priority ?? 99,
		progress: t.beads_snapshot?.progress ?? null,
		// Version metadata (08-10: monotonic versioned state) - included when present
		_version: t._version ?? null,
		_read_at: t._read_at ?? null,
	};
}

export function registerQueryCommands(program: Command): void {
	// ============================================
	// status: Show tiller status and next action
	// ============================================
	program
		.command("status")
		.description("Show tiller status and next action")
		.option("--json", "Output as JSON for agent consumption")
		.option("--pretty", "Human-readable formatted output")
		.option("--short", "One-line summary")
		.action(async (options: { json?: boolean; pretty?: boolean; short?: boolean }) => {
			const tracks = listRuns();
			const agents = await listAgents();
			// HSM filtering with parent-level matching
			// active = executing only (not paused/checkpoint which have their own sections)
			const activeBase = tracks.filter((t) => t.state === "active/executing");
			const pausedBase = tracks.filter((t) => t.state === "active/paused");
			const checkpointBase = tracks.filter((t) => t.state === "active/checkpoint");

			// Reload active/* tracks with version metadata (08-10: monotonic versioned state)
			// This ensures version info is available for observable state
			const active = activeBase.map((t) => loadRunVersioned(t.id) ?? t);
			const paused = pausedBase.map((t) => loadRunVersioned(t.id) ?? t);
			const checkpoint = checkpointBase.map((t) => loadRunVersioned(t.id) ?? t);

			const proposed = tracks.filter((t) => t.state === "proposed");
			const approved = tracks.filter((t) => t.state === "approved");
			const ready = tracks.filter((t) => t.state === "ready");
			const verifying = tracks.filter((t) => matchState(t.state, "verifying"));

			// Detect runs with SUMMARY.autopass.md (pending manual verification)
			// These are runs where automated checks passed but manual checks skipped
			const autopass = tracks.filter((t) => findAutopassSummaryPath(t) !== null);

			// Determine next action and suggested command
			let nextAction = "none";
			let suggestedCmd = "";
			const firstActive = active[0] ?? paused[0];
			const firstVerifying = verifying[0];
			const firstReady = ready[0];
			const firstApproved = approved[0];
			const firstProposed = proposed[0];

			if (checkpoint.length > 0) {
				nextAction = "decide";
				suggestedCmd = `tiller show ${getRunPlanRef(checkpoint[0])}`;
			} else if (active.length > 0) {
				nextAction = "execute";
				suggestedCmd = `tiller sail --plan ${getRunPlanRef(firstActive)}`;
			} else if (paused.length > 0) {
				nextAction = "resume";
				suggestedCmd = `tiller resume ${getRunPlanRef(paused[0])}`;
			} else if (verifying.length > 0) {
				nextAction = "verify";
				suggestedCmd = `tiller verify ${getRunPlanRef(firstVerifying)}`;
			} else if (ready.length > 0) {
				nextAction = "activate";
				suggestedCmd = `tiller activate ${getRunPlanRef(firstReady)}`;
			} else if (approved.length > 0) {
				nextAction = "import";
				suggestedCmd = `tiller start ${getRunPlanRef(firstApproved)}`;
			} else if (proposed.length > 0) {
				nextAction = "approve";
				suggestedCmd = `tiller approve ${getRunPlanRef(firstProposed)}`;
			} else {
				nextAction = "plan";
				suggestedCmd = "tiller plan create";
			}

			// Build core status data
			// getWorkingInitiative returns: workflow.current_initiative (mutable state)
			// or falls back to paths.default_initiative (config)
			const workingInitiative = getWorkingInitiative();
			const redirectInfo = getTillerRedirectInfo();
			const statusData = {
				working_initiative: workingInitiative, // Current focus (state or default)
				next_action: nextAction,
				suggested_cmd: suggestedCmd,
				// Redirect info for worktree support
				...(redirectInfo.isRedirect && {
					redirect: {
						target: redirectInfo.redirectTarget,
						resolved: redirectInfo.targetDir,
					},
				}),
				runs: {
					active: active.map(summarizeTrack),
					paused: paused.map(summarizeTrack),
					proposed: proposed.map(summarizeTrack),
					approved: approved.map(summarizeTrack),
					ready: ready.map(summarizeTrack),
					verifying: verifying.map(summarizeTrack),
					autopass: autopass.map(summarizeTrack),
				},
				agents: agents.map((a) => ({
					agent: a.agent,
					state: a.state,
					run_id: a.run_id,
					stale: isAgentStale(a),
				})),
				checkpoints_pending: checkpoint.flatMap((t) =>
					t.checkpoints.filter((c) => !c.resolved),
				),
			};

			// JSON output (--json flag)
			if (options.json) {
				console.log(JSON.stringify(statusData, null, 2));
				return;
			}

			// Short output (--short flag) - one-line summary
			if (options.short) {
				const parts = [];
				if (active.length > 0) parts.push(`${active.length} active`);
				if (paused.length > 0) parts.push(`${paused.length} paused`);
				if (verifying.length > 0) parts.push(`${verifying.length} verifying`);
				if (autopass.length > 0) parts.push(`${autopass.length} autopass`);
				if (ready.length > 0) parts.push(`${ready.length} ready`);
				if (approved.length > 0) parts.push(`${approved.length} approved`);
				if (proposed.length > 0) parts.push(`${proposed.length} proposed`);
				const summary = parts.length > 0 ? parts.join(", ") : "no runs";
				console.log(`${summary}. Next: ${nextAction}`);
				return;
			}

			// Pretty output function for --pretty flag or TOON prettyFn
			const printPretty = () => {
				// Summary line first
				const parts = [];
				if (active.length > 0) parts.push(`${active.length} active`);
				if (paused.length > 0) parts.push(`${paused.length} paused`);
				if (verifying.length > 0) parts.push(`${verifying.length} verifying`);
				if (autopass.length > 0) parts.push(`${autopass.length} autopass`);
				if (ready.length > 0) parts.push(`${ready.length} ready`);
				if (approved.length > 0) parts.push(`${approved.length} approved`);
				if (proposed.length > 0) parts.push(`${proposed.length} proposed`);
				const summary = parts.length > 0 ? parts.join(", ") : "no runs";

				console.log(`\n${summary}`);
				console.log("═".repeat(59));

				// Helper to extract initiative from plan_path
				const getInitiative = (t: { plan_path: string }) => {
					const match = t.plan_path.match(/plans\/([^/]+)\//);
					return match ? match[1] : "unknown";
				};

				// Show active runs prominently
				if (active.length > 0 || paused.length > 0) {
					console.log("\nActive:");
					for (const t of [...active, ...paused]) {
						const icon = t.state === "active/paused" ? "⏸" : "●";
						console.log(`  ${icon} ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 45)}`);
					}
				}

				// Show verifying
				if (verifying.length > 0) {
					console.log("\nVerifying:");
					for (const t of verifying) {
						console.log(`  ◐ ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 45)}`);
					}
				}

				// Show autopass (pending manual verification)
				if (autopass.length > 0) {
					console.log("\nAutopass (pending manual):");
					for (const t of autopass) {
						console.log(`  ⚠ ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 45)}`);
					}
				}

				// Show ready (actionable)
				if (ready.length > 0) {
					console.log("\nReady:");
					for (const t of ready) {
						console.log(`  ○ ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 45)}`);
					}
				}

				// Group proposed by initiative and show summary
				if (proposed.length > 0) {
					const byInitiative = new Map<string, typeof proposed>();
					for (const t of proposed) {
						const init = getInitiative(t);
						if (!byInitiative.has(init)) byInitiative.set(init, []);
						byInitiative.get(init)!.push(t);
					}

					console.log("\nProposed:");
					for (const [init, plans] of byInitiative) {
						if (plans.length <= 3) {
							// Show individual plans
							for (const t of plans) {
								console.log(`  · ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 45)}`);
							}
						} else {
							// Summarize by initiative
							console.log(`  · ${init}: ${plans.length} plans`);
						}
					}
				}

				// Show checkpoints pending
				const pendingCheckpoints = checkpoint.flatMap((t) =>
					t.checkpoints.filter((c) => !c.resolved),
				);
				if (pendingCheckpoints.length > 0) {
					console.log("\nCheckpoints Pending:");
					for (const cp of pendingCheckpoints) {
						console.log(`  ⚠ ${cp.id}  ${cp.type}  "${truncate(cp.prompt, 35)}"`);
					}
				}

				// Show agents if any
				if (agents.length > 0) {
					console.log("\nAgents:");
					for (const a of agents) {
						const stale = isAgentStale(a) ? " ⚠" : "";
						let trackDisplay = "idle";
						if (a.run_id) {
							const agentTrack = loadRun(a.run_id);
							trackDisplay = agentTrack
								? `→ ${getRunPlanRef(agentTrack)}`
								: `→ ${a.run_id}`;
						}
						console.log(`  ${a.agent}${stale}  [${a.state}]  ${trackDisplay}`);
					}
				}

				console.log(`\n${"─".repeat(59)}`);
				console.log(`Next: ${suggestedCmd}`);
			};

			// Pretty output (--pretty flag)
			if (options.pretty) {
				printPretty();
				return;
			}

			// Default: TOON output with agent_hint for markdown formatting
			const summaryLine = [
				active.length > 0 ? `${active.length} active` : null,
				paused.length > 0 ? `${paused.length} paused` : null,
				verifying.length > 0 ? `${verifying.length} verifying` : null,
				ready.length > 0 ? `${ready.length} ready` : null,
				proposed.length > 0 ? `${proposed.length} proposed` : null,
			].filter(Boolean).join(", ") || "no runs";

			// Build agent hint with optional AskUserQuestion guidance
			const hasCollapsed = proposed.length > 5;
			const hasManyReady = ready.length > 10;
			const hasActionable = active.length > 0 || ready.length > 0;
			// Terminology: initiative (project) > phase (numbered group) > run (plan execution)
			const initMarker = workingInitiative ? ` Working in: ${workingInitiative}.` : "";
			let agentHint = `Format as markdown.${initMarker} Lead with "**Status:** ${summaryLine}".`;
			if (active.length > 0 || verifying.length > 0) {
				agentHint += ` Show active/verifying runs first.`;
			}
			if (hasManyReady) {
				agentHint += ` Group ready runs by INITIATIVE, then PHASE. Show working initiative first:\n**${workingInitiative || "initiative"}** [working] (N runs)\n**other** (N runs)\n| Phase | Runs | Focus |`;
			} else {
				agentHint += ` Show ready runs in table: Ref | Intent.`;
			}
			agentHint += ` End with "Next: \`${suggestedCmd}\`".`;

			if (hasCollapsed && hasActionable) {
				agentHint += ` IMPORTANT: Use AskUserQuestion to ask: "Work on ready task or expand ${proposed.length} proposed plans?" Options: 1) Work on ready (activate suggested), 2) Show proposed plans.`;
			} else if (hasCollapsed && !hasActionable) {
				agentHint += ` IMPORTANT: Use AskUserQuestion to ask: "Show ${proposed.length} proposed plans or approve batch?" Options: 1) Show proposed, 2) Approve all.`;
			}
			outputTOON(
				{ status: statusData },
				{
					agent_hint: agentHint,
					prettyFn: printPretty,
				},
			);
		});

	// ============================================
	// list: List runs
	// ============================================
	program
		.command("list")
		.description("List runs")
		.option(
			"--state <state>",
			"Filter by state (ready|active|verifying|complete|abandoned)",
		)
		.option("--phase <id>", "Filter by phase (e.g., 08, 06.6)")
		.option("--limit <n>", "Limit number of results", (value: string) => {
			const parsed = parseInt(value, 10);
			if (isNaN(parsed) || parsed < 1) {
				console.error(`Error: --limit must be a positive integer, got: ${value}`);
				process.exit(1);
			}
			return parsed;
		})
		.option("--json", "Output as JSON")
		.option("--pretty", "Human-readable formatted output")
		.action((options: { state?: string; phase?: string; limit?: number; json?: boolean; pretty?: boolean }) => {
			// Validate --state if provided
			if (options.state && !isValidStateQuery(options.state)) {
				console.error(`Error: Invalid state '${options.state}'\n`);
				console.error(getStateHelpText());
				process.exit(1);
			}

			let tracks = listRuns(options.state);

			// Apply phase filter
			if (options.phase) {
				const phasePrefix = `${options.phase}-`;
				tracks = tracks.filter((t) => {
					const planRef = getRunPlanRef(t);
					return planRef.startsWith(phasePrefix);
				});
			}

			// Apply limit
			const totalBeforeLimit = tracks.length;
			if (options.limit && options.limit > 0) {
				tracks = tracks.slice(0, options.limit);
			}

			// Build core list data
			const filterDesc = [
				options.state ? `state=${options.state}` : null,
				options.phase ? `phase=${options.phase}` : null,
				options.limit ? `limit=${options.limit}` : null,
			].filter(Boolean).join(", ") || null;

			const listData = {
				runs: tracks.map(summarizeTrack),
				total: tracks.length,
				...(options.limit && totalBeforeLimit > tracks.length ? { total_matched: totalBeforeLimit } : {}),
				filter: filterDesc,
			};

			// JSON output (--json flag)
			if (options.json) {
				console.log(JSON.stringify(listData.runs, null, 2));
				return;
			}

			// Pretty output function for --pretty flag or TOON prettyFn
			const printPretty = () => {
				if (tracks.length === 0) {
					console.log("No runs found.");
					return;
				}

				console.log("RUNS");
				console.log("─".repeat(70));
				console.log("  PLAN          STATE       INTENT");
				console.log("─".repeat(70));

				for (const t of tracks) {
					const planRef = getRunPlanRef(t);
					const stateStr = t.state.padEnd(10);
					console.log(
						"  " +
							planRef.padEnd(12) +
							"  " +
							stateStr +
							"  " +
							truncate(t.intent, 40),
					);
				}

				console.log("─".repeat(70));
				const totalStr = totalBeforeLimit > tracks.length
					? `${tracks.length} of ${totalBeforeLimit}`
					: `${tracks.length}`;
				console.log(`Total: ${totalStr} run(s)`);
			};

			// Pretty output (--pretty flag)
			if (options.pretty) {
				printPretty();
				return;
			}

			// Default: TOON output with agent_hint
			// Group tracks by state for summary
			const byState: Record<string, number> = {};
			for (const t of tracks) {
				const baseState = t.state.split("/")[0];
				byState[baseState] = (byState[baseState] ?? 0) + 1;
			}
			const summary = Object.entries(byState)
				.map(([s, c]) => `${c} ${s}`)
				.join(", ");

			// When filtered, show details; unfiltered, show summary
			const agentHint = filterDesc
				? `Filtered list - show each run with ref, state, and intent. Format: "08-01 [complete] Implement feature..."`
				: `Present as summary: "${tracks.length} runs: ${summary}". Use --phase or --state to see details.`;
			outputTOON(
				{ list: listData },
				{
					agent_hint: agentHint,
					prettyFn: printPretty,
				},
			);
		});

	// ============================================
	// show: Show detailed run info
	// ============================================
	program
		.command("show <ref>")
		.description(
			"Show detailed run info (accepts plan ref like '02-01' or run ID)",
		)
		.option("--json", "Output as JSON")
		.option("--pretty", "Human-readable formatted output")
		.option("--content", "Output full PLAN.md content")
		.option("--initiative <name>", "Target initiative (default: current)")
		.action(
			(
				ref: string,
				options: { json?: boolean; pretty?: boolean; content?: boolean; initiative?: string },
			) => {
				// Support both --initiative flag and initiative:ref syntax
				const resolvedRef = options.initiative && !ref.includes(":")
					? `${options.initiative}:${ref}`
					: ref;

				// First resolve the ref to get run ID
				const unresolvedTrack = resolveRunRef(resolvedRef);

				// 01-23: Fall back to showing plan details if no run exists
				if (!unresolvedTrack) {
					// Parse initiative:ref syntax (e.g., "dogfooding:01-19")
					const parsed = parseInitiativeRef(resolvedRef);
					const effectiveRef = parsed.ref;
					const phasesDir = resolvePhasesDir(parsed.initiative ?? undefined);
					let planPath: string | null = null;

					// Extract phase from ref (e.g., "01-14" -> "01")
					const phaseMatch = effectiveRef.match(/^(\d+(?:\.\d+)?)-/);
					if (phaseMatch) {
						const phaseId = phaseMatch[1];
						// Find phase directory (handles both "01-name" and "01" formats)
						const phaseDirs = readdirSync(phasesDir);
						const phaseDir = phaseDirs.find(
							(d) => d === phaseId || d.startsWith(`${phaseId}-`),
						);
						if (phaseDir) {
							const candidatePath = join(
								phasesDir,
								phaseDir,
								`${effectiveRef}-PLAN.md`,
							);
							if (existsSync(candidatePath)) {
								planPath = candidatePath;
							}
						}
					}

					if (!planPath) {
						console.error(`Not found: ${ref}`);
						console.error(
							"Hint: Use plan ref (e.g., '02-01') or full run ID (e.g., 'run-abc123')",
						);
						process.exit(2);
					}

					// Show plan details for drafted plan
					const content = readFileSync(planPath, "utf-8");
					const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?/m);
					const objMatch = content.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/);
					const phaseFromFile = content.match(/^phase:\s*(.+)$/m)?.[1] || "unknown";
					const typeFromFile = content.match(/^type:\s*(.+)$/m)?.[1] || "execute";

					const title = titleMatch?.[1]?.replace(/^TODO REPHRASE:\s*/i, "") || null;
					const objective = objMatch?.[1]?.trim() || "No objective";

					const planData = {
						plan: {
							ref: effectiveRef,
							state: "drafted",
							path: planPath,
							phase: phaseFromFile,
							type: typeFromFile,
							...(title ? { title } : {}),
							objective,
						},
						hint: "Plan exists but has no run. Use `tiller activate` to start work.",
					};

					const objSnippet =
						objective.length > 40 ? objective.slice(0, 37) + "..." : objective;

					// Pretty output for drafted plan
					const printPretty = () => {
						console.log(`PLAN: ${effectiveRef} [drafted]`);
						console.log("═".repeat(59));
						if (title) console.log(`Title:    ${title}`);
						console.log(`Objective: ${objective}`);
						console.log(`Path:     ${planPath}`);
						console.log(`Phase:    ${phaseFromFile}`);
						console.log(`Type:     ${typeFromFile}`);
						console.log("");
						console.log("To start work: tiller activate " + ref);
					};

					if (options.json) {
						console.log(JSON.stringify(planData, null, 2));
						return;
					}

					if (options.content) {
						console.log(content);
						return;
					}

					outputTOON(planData, {
						pretty: options.pretty,
						prettyFn: printPretty,
						agent_hint: `Plan ${ref} is drafted (no run): ${objSnippet}. To work on it: tiller activate ${ref}`,
					});
					return;
				}

				// Now load with version metadata (08-10: monotonic versioned state)
				let track: Run;
				try {
					const versioned = loadRunVersioned(unresolvedTrack.id);
					if (!versioned) {
						console.error(`Failed to load run: ${ref}`);
						process.exit(1);
					}
					track = versioned;
				} catch (e) {
					if (e instanceof StaleReadError) {
						console.error(`Error: ${e.message}`);
						process.exit(1);
					}
					throw e;
				}

				const planRef = getRunPlanRef(track);

				// Build core track data with plan_ref
				const trackData = {
					...track,
					plan_ref: planRef,
				};

				// JSON output (--json flag)
				if (options.json) {
					console.log(JSON.stringify(trackData, null, 2));
					return;
				}

				// Output full PLAN.md content
				if (options.content) {
					try {
						const content = readPlanFile(track.plan_path);
						console.log(content);
					} catch (_err) {
						console.error(`Failed to read PLAN.md: ${track.plan_path}`);
						process.exit(1);
					}
					return;
				}

				// Pretty output function for --pretty flag or TOON prettyFn
				const printPretty = () => {
					console.log(`PLAN: ${planRef}`);
					console.log("═".repeat(59));
					console.log(`Intent:   ${track.intent}`);
					console.log(`State:    ${track.state}`);
					console.log(`Path:     ${track.plan_path}`);
					console.log(`Run ID:   ${track.id} (internal)`);
					console.log(`Priority: P${track.priority ?? 99}`);
					console.log(`Created:  ${new Date(track.created).toLocaleString()}`);
					console.log(`Updated:  ${new Date(track.updated).toLocaleString()}`);

					// Version metadata (08-10: monotonic versioned state)
					if (track._version) {
						// Note: mtime granularity is filesystem-dependent (~1s on HFS+/FAT32)
						console.log(`Version:  ${track._version} (mtime, ~1s granularity)`);
					}
					if (track._read_at) {
						console.log(`Read at:  ${new Date(track._read_at).toLocaleString()}`);
					}

					if (track.claimed_by) {
						const expired = isClaimExpired(track);
						const claimInfo = expired
							? "(EXPIRED)"
							: `until ${track.claim_expires}`;
						console.log(`Claimed:  ${track.claimed_by} ${claimInfo}`);
					}

					if (track.depends_on && track.depends_on.length > 0) {
						console.log(`Depends:  ${track.depends_on.join(", ")}`);
					}

					if (track.files_touched && track.files_touched.length > 0) {
						console.log(`Files:    ${track.files_touched.join(", ")}`);
					}

					if (track.transitions.length > 0) {
						console.log("\nTRANSITIONS");
						console.log("─".repeat(55));
						for (const tr of track.transitions) {
							const time = new Date(tr.at).toLocaleTimeString();
							console.log(
								"  " +
									time +
									"  " +
									tr.from +
									" → " +
									tr.to +
									" (" +
									tr.by +
									")",
							);
						}
					}

					if (track.beads_snapshot) {
						const snap = track.beads_snapshot;
						const total =
							snap.progress.closed +
							snap.progress.open +
							snap.progress.in_progress;
						const pct =
							total > 0 ? Math.round((snap.progress.closed / total) * 100) : 0;
						const bar = progressBar(pct, 10);

						console.log(
							"\nBEADS SNAPSHOT (synced " +
								new Date(snap.synced_at).toLocaleTimeString() +
								")",
						);
						console.log("─".repeat(55));
						console.log(`  Epic: ${snap.epic_id ?? "none"}`);
						console.log(
							"  Progress: " +
								bar +
								" " +
								pct +
								"% (" +
								snap.progress.closed +
								"/" +
								total +
								")",
						);

						for (const task of snap.tasks) {
							const icon =
								task.status === "closed"
									? "✓"
									: task.status === "in_progress"
										? "→"
										: "○";
							console.log(`  ${icon} ${task.id}  ${task.title}`);
						}
					}

					if (track.checkpoints.length > 0) {
						console.log("\nCHECKPOINTS");
						console.log("─".repeat(55));
						for (const cp of track.checkpoints) {
							const status = cp.resolved
								? `[RESOLVED: ${cp.resolved}]`
								: "[PENDING]";
							console.log(
								"  " +
									cp.id +
									"  " +
									cp.type +
									'  "' +
									truncate(cp.prompt, 30) +
									'"  ' +
									status,
							);
						}
					}

					// Display verification results (automated + UAT)
					if (track.verification) {
						const v = track.verification;

						if (v.automated) {
							const icon =
								v.automated.status === "pass"
									? "✓"
									: v.automated.status === "fail"
										? "✗"
										: "○";
							console.log(
								"\nAUTOMATED VERIFICATION [" +
									icon +
									" " +
									v.automated.status.toUpperCase() +
									"]",
							);
							console.log("─".repeat(55));
							console.log(
								`  Ran: ${new Date(v.automated.ran_at).toLocaleString()}`,
							);
							for (const c of v.automated.checks) {
								const cIcon =
									c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "○";
								console.log(`  ${cIcon} ${c.name}`);
							}
						}

						if (v.uat) {
							const icon =
								v.uat.status === "pass"
									? "✓"
									: v.uat.status === "fail"
										? "✗"
										: "○";
							console.log(
								"\nUAT RESULTS [" +
									icon +
									" " +
									v.uat.status.toUpperCase() +
									"]",
							);
							console.log("─".repeat(55));
							console.log(`  Ran: ${new Date(v.uat.ran_at).toLocaleString()}`);
							console.log(`  Issues logged: ${v.uat.issues_logged || 0}`);
							for (const c of v.uat.checks) {
								const cIcon =
									c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "○";
								console.log(`  ${cIcon} ${c.name}`);
							}
						}
					}
				};

				// Pretty output (--pretty flag)
				if (options.pretty) {
					printPretty();
					return;
				}

				// Default: TOON output with agent_hint
				// Build progress info for hint
				let progressStr = "";
				if (track.beads_snapshot) {
					const snap = track.beads_snapshot;
					const total =
						snap.progress.closed +
						snap.progress.open +
						snap.progress.in_progress;
					progressStr = `, ${snap.progress.closed}/${total} tasks done`;
				}
				const agentHint = `Present as run summary with key details. Good: "Run ${planRef} is ${track.state}: ${truncate(track.intent, 50)}. Priority P${track.priority ?? 99}${progressStr}." Bad: Dumping all fields or raw YAML.`;
				outputTOON(
					{ run: trackData },
					{
						agent_hint: agentHint,
						prettyFn: printPretty,
					},
				);
			},
		);

}
