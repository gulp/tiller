/**
 * Tiller prime command - Agent entry point
 *
 * Syncs draft plans and outputs workflow context.
 * This is the single entry point for agents starting a session.
 *
 * Workflow customization (additive by default):
 * - Place a .tiller/PRIME.md file to ADD project-specific context
 * - User content is shown BEFORE the dynamic default (additive mode)
 * - Use --replace to fully replace default with custom file (old behavior)
 * - Use --export to dump the default content for reference
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
} from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { handNameFromSeed } from "../hands/names.js";
import { PATHS } from "../state/config.js";
import {
	formatHandoffForInjection,
	handoffExists,
	readHandoff,
} from "../state/handoff.js";
import { setWorkingInitiative } from "../state/initiative.js";
import { findDraftPlans, syncDraftPlans } from "../state/sync.js";
import { getRunPlanRef, listRuns } from "../state/run.js";
import { matchState } from "../types/index.js";

// Derived from PATHS (cwd-independent)
const PRIME_PATH = PATHS.PRIME_FILE;
// Claude's agents dir is separate from tiller's .tiller/agents
const CLAUDE_AGENTS_DIR = join(PATHS.PROJECT_ROOT, ".claude/agents");

interface HookInput {
	session_id?: string;
	cwd?: string;
}

/**
 * Try to read hook input from stdin (non-blocking)
 * Returns session_id if running as a SessionStart hook
 *
 * Note: /dev/stdin is Unix-specific. Windows uses different mechanisms.
 */
function tryReadHookInput(): HookInput | null {
	try {
		// Check if stdin has data (non-TTY means piped input)
		if (process.stdin.isTTY) {
			return null;
		}

		// /dev/stdin is Unix-only - skip on Windows
		if (platform() === "win32") {
			// Windows doesn't support /dev/stdin; hooks would need different approach
			return null;
		}

		// Read synchronously with a small buffer (Unix only)
		const fd = openSync("/dev/stdin", "r");
		const buf = Buffer.alloc(4096);
		const bytesRead = readSync(fd, buf, 0, 4096, null);
		closeSync(fd);

		if (bytesRead === 0) return null;

		const input = buf.subarray(0, bytesRead).toString("utf-8").trim();
		if (!input.startsWith("{")) return null;

		return JSON.parse(input) as HookInput;
	} catch {
		return null;
	}
}

/**
 * Setup session: create agent dir, output banner
 */
function setupSession(sessionId: string): void {
	// CLAUDE_AGENTS_DIR is already absolute (derived from PROJECT_ROOT)
	const agentDir = join(CLAUDE_AGENTS_DIR, sessionId);

	// Create agent directory
	mkdirSync(agentDir, { recursive: true });

	// Generate deterministic mate name from session
	const mateName = handNameFromSeed(sessionId);

	console.log("");
	console.log("═".repeat(59));
	console.log(`✅ SESSION: ${sessionId.slice(0, 8)}... → mate: ${mateName}`);
	console.log("═".repeat(59));
	console.log("");
	console.log("Run tiller commands with session context:");
	console.log(`  TILLER_SESSION=${sessionId} tiller sail --plan <ref>`);
	console.log("");
}

function truncate(s: string, len: number): string {
	return s.length > len ? `${s.slice(0, len - 3)}...` : s;
}

// Path to default prime template (relative to this file's compiled location)
const PRIME_TEMPLATE_PATH = join(
	import.meta.dirname,
	"../templates/PRIME_DEFAULT.md",
);

function getDefaultPrimeContent(): string {
	return readFileSync(PRIME_TEMPLATE_PATH, "utf-8");
}

export function registerPrimeCommand(program: Command): void {
	program
		.command("prime")
		.description(
			"Sync draft plans and output workflow context (agent entry point)",
		)
		.option("--json", "Output as JSON")
		.option("--export", "Output default content (ignores PRIME.md)")
		.option("--replace", "Replace mode: custom PRIME.md fully replaces default")
		.option("--full", "Include full handoff context from .continue-here.md files")
		.action(
			(options: { json?: boolean; export?: boolean; replace?: boolean; full?: boolean }) => {
				// --export: dump default content for customization
				if (options.export) {
					console.log(getDefaultPrimeContent());
					return;
				}

				// Step 0: Check for hook input (SessionStart passes session_id via stdin)
				const hookInput = tryReadHookInput();
				if (hookInput?.session_id) {
					setupSession(hookInput.session_id);
				}

				// Check if .tiller/ exists - skip if not a tiller project
				if (!existsSync(PATHS.TILLER_DIR)) {
					// Not a tiller project, exit silently (for hooks)
					return;
				}

				// Clear focus on session start (fresh session = no assumptions)
				// This prevents cross-session pollution when multiple agents work in same directory
				setWorkingInitiative(null);

				// Step 1: Sync draft plans (always, before output)
				const drafts = findDraftPlans();

				if (drafts.length > 0) {
					console.log(`Syncing ${drafts.length} draft plan(s)...`);
				}

				const syncResult = syncDraftPlans();

				if (syncResult.imported.length > 0) {
					for (const path of syncResult.imported) {
						const ref =
							path.match(/(\d+(?:\.\d+)?-\d+)-PLAN\.md/i)?.[1] || path;
						console.log(`  ✓ ${ref} → ready`);
					}
					console.log("");
				}

				if (syncResult.errors.length > 0) {
					for (const err of syncResult.errors) {
						console.error(`  ✗ ${err}`);
					}
					console.log("");
				}

				// Step 2: Get current state
				const allTracks = listRuns();
				const proposed = allTracks.filter((t) => t.state === "proposed");
				const approved = allTracks.filter((t) => t.state === "approved");
				const ready = allTracks.filter((t) => t.state === "ready");
				const active = allTracks.filter((t) => matchState(t.state, "active"));
				const verifying = allTracks.filter((t) =>
					matchState(t.state, "verifying"),
				);

				// Step 3: Determine next action
				let nextAction = "plan";
				let suggestion = "";

				if (active.length > 0) {
					nextAction = "execute";
					suggestion = `Continue: tiller show ${getRunPlanRef(active[0])}`;
				} else if (verifying.length > 0) {
					nextAction = "verify";
					suggestion = `Verify: tiller verify ${getRunPlanRef(verifying[0])}`;
				} else if (ready.length > 0) {
					nextAction = "activate";
					suggestion = `Activate: tiller activate ${getRunPlanRef(ready[0])}`;
				} else if (approved.length > 0) {
					nextAction = "import";
					suggestion = `Import: tiller import ${getRunPlanRef(approved[0])}`;
				} else if (proposed.length > 0) {
					nextAction = "approve";
					if (proposed.length > 3) {
						suggestion = "Approve all: tiller approve --all";
					} else {
						suggestion = `Approve: tiller approve ${getRunPlanRef(proposed[0])}`;
					}
				}

				if (options.json) {
					// Build base output
					const output: Record<string, unknown> = {
						synced: syncResult.imported.length,
						errors: syncResult.errors,
						proposed: proposed.map((t) => getRunPlanRef(t)),
						approved: approved.map((t) => getRunPlanRef(t)),
						ready: ready.map((t) => getRunPlanRef(t)),
						active: active.map((t) => getRunPlanRef(t)),
						verifying: verifying.map((t) => getRunPlanRef(t)),
						next_action: nextAction,
						suggestion,
					};

					// Include handoff context when --full
					if (options.full) {
						const handoffs: Record<string, unknown>[] = [];
						for (const t of allTracks) {
							if (handoffExists(t)) {
								const handoff = readHandoff(t);
								if (handoff) {
									handoffs.push({
										plan: getRunPlanRef(t),
										state: t.state,
										...handoff,
									});
								}
							}
						}
						output.handoffs = handoffs;
					}

					console.log(JSON.stringify(output, null, 2));
					return;
				}

				// Output workflow context
				const hasCustomPrime = existsSync(PRIME_PATH);

				if (hasCustomPrime) {
					// Output user's custom content
					console.log(readFileSync(PRIME_PATH, "utf-8"));

					if (!options.replace) {
						// Additive mode (default): separator then dynamic default
						console.log("\n---\n");
						console.log(getDefaultPrimeContent());
					}
					// In --replace mode, skip default entirely
				} else {
					// No custom file: just output default
					console.log(getDefaultPrimeContent());
				}

				// Dynamic status
				console.log("\n## Current Status");
				console.log("");

				if (proposed.length > 0) {
					console.log(`\nProposed (${proposed.length}):`);
					for (const t of proposed.slice(0, 5)) {
						console.log(
							`  ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 40)}`,
						);
					}
					if (proposed.length > 5)
						console.log(`  ... and ${proposed.length - 5} more`);
				}

				if (approved.length > 0) {
					console.log(`\nApproved (${approved.length}):`);
					for (const t of approved.slice(0, 5)) {
						console.log(
							`  ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 40)}`,
						);
					}
					if (approved.length > 5)
						console.log(`  ... and ${approved.length - 5} more`);
				}

				if (ready.length > 0) {
					console.log(`\nReady (${ready.length}):`);
					for (const t of ready) {
						console.log(
							`  ${getRunPlanRef(t).padEnd(10)} ${truncate(t.intent, 40)}`,
						);
					}
				}

				if (active.length > 0) {
					console.log(`\nActive (${active.length}):`);
					for (const t of active) {
						console.log(
							`  ${getRunPlanRef(t).padEnd(10)} [${t.state}]  ${truncate(t.intent, 30)}`,
						);
					}
				}

				if (verifying.length > 0) {
					console.log(`\nVerifying (${verifying.length}):`);
					for (const t of verifying) {
						console.log(
							`  ${getRunPlanRef(t).padEnd(10)} [${t.state}]  ${truncate(t.intent, 30)}`,
						);
					}
				}

				// --full: Output handoff context for paused tracks
				if (options.full) {
					// Find all tracks with handoff files (typically active/paused)
					const tracksWithHandoff = allTracks.filter((t) => handoffExists(t));

					if (tracksWithHandoff.length > 0) {
						console.log("\n## Session Handoff Context\n");

						for (const t of tracksWithHandoff) {
							const handoff = readHandoff(t);
							if (handoff) {
								console.log(`### ${getRunPlanRef(t)} (${t.state})\n`);
								console.log(formatHandoffForInjection(handoff));
								console.log("");
							}
						}
					} else {
						console.log("\n## Session Handoff Context\n");
						console.log("No handoff files found. Use `tiller pause` to create one.\n");
					}
				}

				console.log(`\n${"─".repeat(50)}`);
				console.log(`Next: ${suggestion || "Create a plan"}`);
			},
		);
}
