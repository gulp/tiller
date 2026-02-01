/**
 * Tiller debug commands - Persistent debugging sessions with scientific method
 *
 * Commands:
 *   tiller debug start <title>    - Start a new debug session
 *   tiller debug status [slug]    - Show debug session status
 *   tiller debug list             - List all active debug sessions
 *   tiller debug resolve <slug>   - Mark session as resolved
 *   tiller debug abandon <slug>   - Abandon a debug session
 *
 * The debug session persists in .planning/debug/[slug].md and survives /clear.
 * Uses scientific method: Evidence -> Hypothesis -> Test -> Confirm/Eliminate
 */

import type { Command } from "commander";
import {
	abandonDebugSession,
	addDebugEvidence,
	addDebugHypothesis,
	confirmRootCause,
	createDebugSession,
	type DebugSession,
	type DebugStatus,
	formatDebugForInjection,
	getDebugPath,
	listDebugSessions,
	listResolvedSessions,
	readDebugSession,
	recordFix,
	resolveDebugSession,
	updateDebugStatus,
	updateHypothesis,
} from "../state/debug.js";
import { outputTOON } from "../types/toon.js";

/**
 * Format session for list display
 */
function formatSessionListItem(session: DebugSession): string {
	const statusIcon = {
		"evidence-gathering": "🔍",
		"hypothesis-testing": "🧪",
		"root-cause-confirmed": "✅",
		resolved: "✓",
		abandoned: "✗",
	}[session.metadata.status];

	const hypothesesCount = session.context.hypotheses.length;
	const evidenceCount = session.context.evidence.length;

	return `${statusIcon} ${session.metadata.slug} - ${session.metadata.title}
   Status: ${session.metadata.status}
   Evidence: ${evidenceCount} | Hypotheses: ${hypothesesCount}
   Updated: ${session.metadata.updated}`;
}

/**
 * Format session for detailed display
 */
function formatSessionDetails(session: DebugSession): string {
	const lines: string[] = [];

	lines.push(`# Debug Session: ${session.metadata.title}`);
	lines.push("");
	lines.push(`**ID:** ${session.metadata.id}`);
	lines.push(`**Slug:** ${session.metadata.slug}`);
	lines.push(`**Status:** ${session.metadata.status}`);
	lines.push(`**Created:** ${session.metadata.created}`);
	lines.push(`**Updated:** ${session.metadata.updated}`);
	if (session.metadata.run_id) {
		lines.push(`**Linked Run:** ${session.metadata.run_id}`);
	}
	lines.push("");

	// Symptoms
	lines.push("## Symptoms");
	lines.push("");
	if (session.context.symptoms.description) {
		lines.push(session.context.symptoms.description);
	} else {
		lines.push("(Not documented)");
	}
	lines.push("");

	// Evidence
	lines.push("## Evidence");
	lines.push("");
	if (session.context.evidence.length > 0) {
		for (const e of session.context.evidence) {
			lines.push(`- **${e.description}** (from ${e.source})`);
		}
	} else {
		lines.push("(No evidence collected)");
	}
	lines.push("");

	// Hypotheses
	lines.push("## Hypotheses");
	lines.push("");
	if (session.context.hypotheses.length > 0) {
		for (const [i, h] of session.context.hypotheses.entries()) {
			const statusIcon =
				h.status === "confirmed" ? "✅" : h.status === "eliminated" ? "❌" : "❓";
			lines.push(`${i + 1}. ${statusIcon} ${h.description} [${h.status}]`);
			if (h.test_performed) {
				lines.push(`   Test: ${h.test_performed}`);
			}
			if (h.test_result) {
				lines.push(`   Result: ${h.test_result}`);
			}
		}
	} else {
		lines.push("(No hypotheses)");
	}
	lines.push("");

	// Root Cause
	lines.push("## Root Cause");
	lines.push("");
	lines.push(session.context.root_cause || "(Not yet confirmed)");
	lines.push("");

	// Fix
	lines.push("## Fix Applied");
	lines.push("");
	lines.push(session.context.fix_applied || "(None)");
	lines.push("");

	// Next steps based on status
	lines.push("## Next Steps");
	lines.push("");
	switch (session.metadata.status) {
		case "evidence-gathering":
			lines.push("1. Gather more evidence with `tiller debug evidence`");
			lines.push("2. Form hypotheses with `tiller debug hypothesis`");
			lines.push("3. Update status with `tiller debug update --status hypothesis-testing`");
			break;
		case "hypothesis-testing":
			lines.push("1. Test hypotheses and record results with `tiller debug test`");
			lines.push("2. Eliminate or confirm hypotheses");
			lines.push("3. Confirm root cause with `tiller debug root-cause`");
			break;
		case "root-cause-confirmed":
			lines.push("1. Apply the fix");
			lines.push("2. Record fix with `tiller debug fix`");
			lines.push("3. Verify and resolve with `tiller debug resolve`");
			break;
		case "resolved":
			lines.push("Session complete. Review in `.planning/debug/resolved/`");
			break;
		case "abandoned":
			lines.push("Session abandoned. Review in `.planning/debug/resolved/`");
			break;
	}

	return lines.join("\n");
}

export function registerDebugCommands(program: Command): void {
	const debug = program
		.command("debug")
		.description("Persistent debugging sessions with scientific method");

	// ============================================
	// debug start - Create a new debug session
	// ============================================
	debug
		.command("start <title>")
		.description("Start a new debug session")
		.option("--symptoms <text>", "Initial symptoms description")
		.option("--run <ref>", "Link to a tiller run")
		.option("--json", "Output as JSON")
		.action(
			(
				title: string,
				options: { symptoms?: string; run?: string; json?: boolean },
			) => {
				const session = createDebugSession(
					title,
					options.symptoms,
					options.run,
				);

				if (options.json) {
					outputTOON({
						debug_session: {
							created: true,
							id: session.metadata.id,
							slug: session.metadata.slug,
							path: getDebugPath(session.metadata.slug),
							status: session.metadata.status,
						},
					});
				} else {
					console.log(`✓ Debug session created: ${session.metadata.slug}`);
					console.log(`  Path: ${getDebugPath(session.metadata.slug)}`);
					console.log(`  Status: ${session.metadata.status}`);
					console.log("");
					console.log("Next steps:");
					console.log(`  1. Document symptoms: tiller debug update ${session.metadata.slug} --symptoms "..."`);
					console.log(`  2. Add evidence: tiller debug evidence ${session.metadata.slug} "description" --source "file.ts:42"`);
					console.log(`  3. Form hypothesis: tiller debug hypothesis ${session.metadata.slug} "possible cause"`);
				}
			},
		);

	// ============================================
	// debug list - List all debug sessions
	// ============================================
	debug
		.command("list")
		.description("List all debug sessions")
		.option("--resolved", "Include resolved/abandoned sessions")
		.option("--json", "Output as JSON")
		.action((options: { resolved?: boolean; json?: boolean }) => {
			const activeSessions = listDebugSessions();
			const resolvedSessions = options.resolved ? listResolvedSessions() : [];

			if (options.json) {
				outputTOON({
					debug_sessions: {
						active: activeSessions.map((s) => ({
							slug: s.metadata.slug,
							title: s.metadata.title,
							status: s.metadata.status,
							updated: s.metadata.updated,
						})),
						resolved: resolvedSessions.map((s) => ({
							slug: s.metadata.slug,
							title: s.metadata.title,
							status: s.metadata.status,
							updated: s.metadata.updated,
						})),
					},
				});
				return;
			}

			if (activeSessions.length === 0 && resolvedSessions.length === 0) {
				console.log("No debug sessions found.");
				console.log("");
				console.log("Start one with: tiller debug start <title>");
				return;
			}

			if (activeSessions.length > 0) {
				console.log("Active Debug Sessions:");
				console.log("".padEnd(40, "─"));
				for (const session of activeSessions) {
					console.log(formatSessionListItem(session));
					console.log("");
				}
			}

			if (resolvedSessions.length > 0) {
				console.log("Resolved Sessions:");
				console.log("".padEnd(40, "─"));
				for (const session of resolvedSessions) {
					console.log(formatSessionListItem(session));
					console.log("");
				}
			}
		});

	// ============================================
	// debug status - Show session status
	// ============================================
	debug
		.command("status [slug]")
		.description("Show debug session status (defaults to most recent)")
		.option("--json", "Output as JSON")
		.option("--inject", "Format for prompt injection")
		.action(
			(
				slug: string | undefined,
				options: { json?: boolean; inject?: boolean },
			) => {
				let session: DebugSession | null = null;

				if (slug) {
					session = readDebugSession(slug);
					if (!session) {
						console.error(`Debug session not found: ${slug}`);
						process.exit(2);
					}
				} else {
					// Get most recent active session
					const sessions = listDebugSessions();
					if (sessions.length === 0) {
						console.log("No active debug sessions.");
						console.log("Start one with: tiller debug start <title>");
						return;
					}
					session = sessions[0];
				}

				if (options.inject) {
					console.log(formatDebugForInjection(session));
					return;
				}

				if (options.json) {
					outputTOON({
						debug_session: {
							metadata: session.metadata,
							context: session.context,
							path: getDebugPath(session.metadata.slug),
						},
					});
					return;
				}

				console.log(formatSessionDetails(session));
			},
		);

	// ============================================
	// debug update - Update session status or symptoms
	// ============================================
	debug
		.command("update <slug>")
		.description("Update debug session status or symptoms")
		.option(
			"--status <status>",
			"New status (evidence-gathering, hypothesis-testing, root-cause-confirmed)",
		)
		.option("--symptoms <text>", "Update symptoms description")
		.option("--json", "Output as JSON")
		.action(
			(
				slug: string,
				options: { status?: string; symptoms?: string; json?: boolean },
			) => {
				let session = readDebugSession(slug);
				if (!session) {
					console.error(`Debug session not found: ${slug}`);
					process.exit(2);
				}

				if (options.status) {
					const validStatuses: DebugStatus[] = [
						"evidence-gathering",
						"hypothesis-testing",
						"root-cause-confirmed",
					];
					if (!validStatuses.includes(options.status as DebugStatus)) {
						console.error(`Invalid status: ${options.status}`);
						console.error(`Valid values: ${validStatuses.join(", ")}`);
						process.exit(1);
					}
					session = updateDebugStatus(slug, options.status as DebugStatus);
				}

				if (options.symptoms && session) {
					session.context.symptoms.description = options.symptoms;
					session.metadata.updated = new Date().toISOString();
					// Re-save via import
					const { saveDebugSession } = require("../state/debug.js");
					saveDebugSession(session);
				}

				if (!session) {
					console.error("Failed to update session");
					process.exit(1);
				}

				if (options.json) {
					outputTOON({
						debug_session: {
							updated: true,
							slug: session.metadata.slug,
							status: session.metadata.status,
						},
					});
				} else {
					console.log(`✓ Debug session updated: ${session.metadata.slug}`);
					console.log(`  Status: ${session.metadata.status}`);
				}
			},
		);

	// ============================================
	// debug evidence - Add evidence to session
	// ============================================
	debug
		.command("evidence <slug> <description>")
		.description("Add evidence to a debug session")
		.option("--source <source>", "Source of evidence (file path, command, etc.)")
		.option("--json", "Output as JSON")
		.action(
			(
				slug: string,
				description: string,
				options: { source?: string; json?: boolean },
			) => {
				const session = addDebugEvidence(slug, {
					description,
					source: options.source ?? "manual entry",
				});

				if (!session) {
					console.error(`Debug session not found: ${slug}`);
					process.exit(2);
				}

				if (options.json) {
					outputTOON({
						evidence: {
							added: true,
							slug,
							count: session.context.evidence.length,
						},
					});
				} else {
					console.log(`✓ Evidence added to ${slug}`);
					console.log(`  Total evidence: ${session.context.evidence.length}`);
				}
			},
		);

	// ============================================
	// debug hypothesis - Add hypothesis to session
	// ============================================
	debug
		.command("hypothesis <slug> <description>")
		.description("Add a hypothesis to a debug session")
		.option("--json", "Output as JSON")
		.action(
			(slug: string, description: string, options: { json?: boolean }) => {
				const session = addDebugHypothesis(slug, description);

				if (!session) {
					console.error(`Debug session not found: ${slug}`);
					process.exit(2);
				}

				if (options.json) {
					outputTOON({
						hypothesis: {
							added: true,
							slug,
							count: session.context.hypotheses.length,
						},
					});
				} else {
					console.log(`✓ Hypothesis added to ${slug}`);
					console.log(`  Total hypotheses: ${session.context.hypotheses.length}`);
				}
			},
		);

	// ============================================
	// debug test - Record test result for hypothesis
	// ============================================
	debug
		.command("test <slug> <index>")
		.description("Record test result for a hypothesis (1-indexed)")
		.option("--test <text>", "Test performed")
		.option("--result <text>", "Test result")
		.option("--confirm", "Mark hypothesis as confirmed")
		.option("--eliminate", "Mark hypothesis as eliminated")
		.option("--json", "Output as JSON")
		.action(
			(
				slug: string,
				indexStr: string,
				options: {
					test?: string;
					result?: string;
					confirm?: boolean;
					eliminate?: boolean;
					json?: boolean;
				},
			) => {
				const index = parseInt(indexStr, 10) - 1; // Convert to 0-indexed
				if (isNaN(index) || index < 0) {
					console.error("Invalid hypothesis index (must be 1 or greater)");
					process.exit(1);
				}

				const status = options.confirm
					? "confirmed"
					: options.eliminate
						? "eliminated"
						: undefined;

				const session = updateHypothesis(slug, index, {
					status,
					test_performed: options.test,
					test_result: options.result,
				});

				if (!session) {
					console.error(`Debug session not found or invalid hypothesis index: ${slug}`);
					process.exit(2);
				}

				const hypothesis = session.context.hypotheses[index];

				if (options.json) {
					outputTOON({
						hypothesis: {
							updated: true,
							slug,
							index: index + 1,
							status: hypothesis.status,
						},
					});
				} else {
					console.log(`✓ Hypothesis ${index + 1} updated: ${hypothesis.status}`);
					if (hypothesis.test_performed) {
						console.log(`  Test: ${hypothesis.test_performed}`);
					}
					if (hypothesis.test_result) {
						console.log(`  Result: ${hypothesis.test_result}`);
					}
				}
			},
		);

	// ============================================
	// debug root-cause - Confirm root cause
	// ============================================
	debug
		.command("root-cause <slug> <description>")
		.description("Confirm the root cause of the issue")
		.option("--json", "Output as JSON")
		.action(
			(slug: string, description: string, options: { json?: boolean }) => {
				const session = confirmRootCause(slug, description);

				if (!session) {
					console.error(`Debug session not found: ${slug}`);
					process.exit(2);
				}

				if (options.json) {
					outputTOON({
						root_cause: {
							confirmed: true,
							slug,
							status: session.metadata.status,
						},
					});
				} else {
					console.log(`✓ Root cause confirmed for ${slug}`);
					console.log(`  Status: ${session.metadata.status}`);
					console.log("");
					console.log("Next: Apply fix and run `tiller debug fix <slug> \"description\"`");
				}
			},
		);

	// ============================================
	// debug fix - Record fix applied
	// ============================================
	debug
		.command("fix <slug> <description>")
		.description("Record the fix applied")
		.option("--json", "Output as JSON")
		.action(
			(slug: string, description: string, options: { json?: boolean }) => {
				const session = recordFix(slug, description);

				if (!session) {
					console.error(`Debug session not found: ${slug}`);
					process.exit(2);
				}

				if (options.json) {
					outputTOON({
						fix: {
							recorded: true,
							slug,
						},
					});
				} else {
					console.log(`✓ Fix recorded for ${slug}`);
					console.log("");
					console.log("Next: Verify fix and run `tiller debug resolve <slug> \"verification\"`");
				}
			},
		);

	// ============================================
	// debug resolve - Resolve session
	// ============================================
	debug
		.command("resolve <slug>")
		.description("Mark debug session as resolved")
		.option("--verify <text>", "Verification description")
		.option("--json", "Output as JSON")
		.action(
			(slug: string, options: { verify?: string; json?: boolean }) => {
				const verification =
					options.verify ?? "Verified manually - fix confirmed working";
				const session = resolveDebugSession(slug, verification);

				if (!session) {
					console.error(`Debug session not found: ${slug}`);
					process.exit(2);
				}

				if (options.json) {
					outputTOON({
						debug_session: {
							resolved: true,
							slug,
							status: session.metadata.status,
						},
					});
				} else {
					console.log(`✓ Debug session resolved: ${slug}`);
					console.log(`  Archived to: .planning/debug/resolved/${slug}.md`);
				}
			},
		);

	// ============================================
	// debug abandon - Abandon session
	// ============================================
	debug
		.command("abandon <slug>")
		.description("Abandon a debug session")
		.option("--reason <text>", "Reason for abandoning")
		.option("--json", "Output as JSON")
		.action(
			(slug: string, options: { reason?: string; json?: boolean }) => {
				const session = abandonDebugSession(slug, options.reason);

				if (!session) {
					console.error(`Debug session not found: ${slug}`);
					process.exit(2);
				}

				if (options.json) {
					outputTOON({
						debug_session: {
							abandoned: true,
							slug,
							reason: options.reason,
						},
					});
				} else {
					console.log(`✓ Debug session abandoned: ${slug}`);
					if (options.reason) {
						console.log(`  Reason: ${options.reason}`);
					}
					console.log(`  Archived to: .planning/debug/resolved/${slug}.md`);
				}
			},
		);
}
