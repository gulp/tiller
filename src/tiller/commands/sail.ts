/**
 * Tiller sail command - Execute assigned plan
 *
 * Usage: tiller sail            (use assigned plan from claimed mate)
 *        tiller sail --plan X   (execute specific plan without mate)
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { handNameFromSeed } from "../hands/names.js";
import { readPlanFile } from "../state/paths.js";
import {
	extractHtmlTag,
	extractListItemsWithCode,
} from "../markdown/parser.js";
import {
	addMate,
	getCurrentSession,
	getMate,
	getMateBySession,
	updateMate,
} from "../mate/registry.js";
import { MATE_ENV } from "../mate/types.js";
import {
	applyTransition,
	getRunPlanRef,
	resolveRunRef,
	saveRun,
} from "../state/run.js";
import type { RunState } from "../types/index.js";
import { outputTOON } from "../types/toon.js";

interface ParsedTask {
	number: number;
	type: string;
	name: string;
	files: string;
	action: string;
}

export function registerSailCommand(program: Command): void {
	program
		.command("sail")
		.description("Execute assigned plan (use --mate or --plan)")
		.option("--mate <name>", "Mate name to sail as (uses assigned plan)")
		.option("--plan <ref>", "Override: sail specific plan instead of assigned")
		.option("--solo", "Skip mate registration (untracked ephemeral work)")
		.action(async (opts: { mate?: string; plan?: string; solo?: boolean }) => {
			// Get mate from: 1) --mate option, 2) env var, 3) session lookup/auto-register
			let mateName = opts.mate || process.env[MATE_ENV.TILLER_MATE];

			if (!mateName && !opts.solo) {
				// Auto-detect or auto-register from TILLER_SESSION
				const sessionId = getCurrentSession();
				if (sessionId) {
					const mateBySession = getMateBySession(sessionId);
					if (mateBySession) {
						mateName = mateBySession.name;
						console.log(
							`[auto] Detected mate: ${mateName} (session ${sessionId.slice(0, 8)}...)`,
						);
					} else {
						// Auto-register: create mate from session ID
						const autoName = handNameFromSeed(sessionId);
						try {
							addMate(autoName);
							console.log(
								`[auto] Registered mate: ${autoName} (session ${sessionId.slice(0, 8)}...)`,
							);
						} catch (e) {
							const errMsg = (e as Error).message;
							if (errMsg.includes("already exists")) {
								console.log(`[auto] Using existing mate: ${autoName}`);
							} else {
								// Actual error - log and continue with claim attempt
								if (process.env.TILLER_DEBUG) {
									console.error(`[tiller sail] addMate error: ${errMsg}`);
								}
								console.log(`[auto] Reusing mate: ${autoName}`);
							}
						}
						// Claim it for this session
						updateMate(autoName, {
							state: "claimed",
							claimedBy: process.pid,
							claimedBySession: sessionId,
							claimedAt: new Date().toISOString(),
						});
						mateName = autoName;
					}
				}
			}

			// Determine plan to execute
			let planRef: string | null = opts.plan || null;

			if (!planRef && mateName) {
				const mate = getMate(mateName);
				if (!mate) {
					console.error(`Mate not found: ${mateName}`);
					process.exit(1);
				}
				planRef = mate.assignedPlan;
			}

			if (!planRef) {
				if (mateName) {
					console.error(`No plan assigned to ${mateName}`);
					console.error(
						`Orchestrator should run: tiller assign <plan> --to ${mateName}`,
					);
				} else {
					console.error("No mate and no --plan specified.\n");
					console.error("Options:");
					console.error(
						"  TILLER_SESSION=<id> tiller sail --plan <ref>  # auto-registers mate",
					);
					console.error(
						"  tiller sail --plan <ref> --solo              # untracked ephemeral work",
					);
				}
				process.exit(1);
			}

			// Warn if --solo mode (explicitly untracked)
			if (opts.solo) {
				console.warn(
					"[solo] Untracked ephemeral work - not registered in mate registry.\n",
				);
			}

			// Resolve track
			const track = resolveRunRef(planRef);
			if (!track) {
				console.error(`Plan not found: ${planRef}`);
				process.exit(1);
			}

			const resolvedRef = getRunPlanRef(track);

			// Update mate state if we have one
			if (mateName) {
				updateMate(mateName, { state: "sailing" });
			}

			// Ensure track is in active state (transition if needed)
			if (
				track.state === "proposed" ||
				track.state === "approved" ||
				track.state === "ready"
			) {
				// Auto-activate the track
				const result = applyTransition(
					track,
					"active/executing" as RunState,
					"agent",
				);
				if (!result.success) {
					console.error(`Failed to activate run: ${result.error}`);
					process.exit(1);
				}
				console.log(`Auto-activated run: ${track.state} → active/executing`);
			} else {
				saveRun(track); // Just save any updates
			}

			console.log(`⛵ Sailing: ${resolvedRef}`);
			if (mateName) {
				console.log(`Mate: ${mateName}`);
			}
			console.log(`State: ${track.state}`);
			console.log(`Plan: ${track.plan_path}\n`);

			// Parse plan content
			const content = readPlanFile(track.plan_path);
			const objective = parseObjective(content);
			const tasks = parseTasks(content);
			const verification = parseVerification(content);

			// Output as TOON
			outputTOON({
				sail: {
					mate: mateName || "solo",
					ref: resolvedRef,
					objective,
					tasks: tasks.map((t) => ({
						number: t.number,
						type: t.type,
						name: t.name,
						files: t.files,
						action: t.action,
					})),
					verification,
				},
			});

			console.log(
				"\nTask: Execute each task in order. Use TodoWrite to track progress.",
			);
			console.log(`Hint: When complete, run: tiller verify ${resolvedRef}`);
		});
}

function parseObjective(content: string): string {
	const section = extractHtmlTag(content, "objective");
	if (!section) return "";
	// Return first paragraph (first line of content)
	return section.trim().split("\n")[0] || "";
}

function parseTasks(content: string): ParsedTask[] {
	const tasksSection = extractHtmlTag(content, "tasks");
	if (!tasksSection) return [];

	// Parse individual <task> elements
	// Pattern: <task type="auto|checkpoint|manual">
	const taskPattern =
		/<task\s+type="([^"]+)">\s*<name>([^<]+)<\/name>\s*<files>([^<]*)<\/files>\s*<action>([\s\S]*?)<\/action>\s*<\/task>/g;

	const tasks: ParsedTask[] = [];
	let match;
	let number = 1;

	while ((match = taskPattern.exec(tasksSection)) !== null) {
		tasks.push({
			number: number++,
			type: match[1],
			name: match[2].trim(),
			files: match[3].trim(),
			action: match[4].trim(),
		});
	}

	return tasks;
}

function parseVerification(content: string): string[] {
	const section = extractHtmlTag(content, "verification");
	if (!section) return [];

	return extractListItemsWithCode(section).map((item) =>
		// Remove checkbox prefix if present
		item
			.replace(/^\[.\]\s*/, "")
			.trim(),
	);
}
