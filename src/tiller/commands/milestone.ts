/**
 * Tiller milestone commands - Version-based release management
 *
 * Commands:
 *   tiller milestone create <version>   - Create a new milestone
 *   tiller milestone list               - List all milestones
 *   tiller milestone status [version]   - Show milestone status
 *   tiller milestone complete <version> - Complete and archive milestone
 *   tiller milestone archive <version>  - Archive roadmap only (no completion)
 *   tiller milestone set-current <ver>  - Set current milestone
 *
 * Milestones group phases for release management. Status is derived from
 * phase states, not stored.
 */

import { execSync } from "node:child_process";
import type { Command } from "commander";
import {
	canCompleteMilestone,
	completeMilestone,
	createMilestone,
	deleteMilestone,
	formatMilestoneForInjection,
	getCurrentMilestone,
	getMilestone,
	getMilestoneStats,
	listArchivedMilestones,
	listMilestones,
	type Milestone,
	parseMilestonesFromRoadmap,
	setCurrentMilestone,
	suggestMilestoneFromRoadmap,
	updateMilestone,
} from "../state/milestone.js";
import {
	createConfirmation,
	formatConfirmationTOON,
	outputTOON,
} from "../types/toon.js";
import { getConfirmMode } from "../state/config.js";

/**
 * Check if we should show confirmation TOON
 */
function shouldConfirm(options: { confirm?: boolean }): boolean {
	if (options.confirm === true) return true;
	if (options.confirm === false) return false;
	return getConfirmMode();
}

/**
 * Format milestone for list display
 */
function formatMilestoneListItem(milestone: Milestone): string {
	const statusIcon = {
		planning: "○",
		active: "●",
		verifying: "◑",
		ready: "✓",
		archived: "□",
	}[milestone.status];

	const { progress } = milestone;
	const progressStr = `${progress.complete_phases}/${progress.total_phases} phases`;

	return `${statusIcon} v${milestone.metadata.version}: ${milestone.metadata.title}
   Status: ${milestone.status}
   Progress: ${progressStr}
   Phases: ${milestone.metadata.phases.join(", ")}`;
}

/**
 * Format milestone for detailed display
 */
function formatMilestoneDetails(milestone: Milestone): string {
	const lines: string[] = [];
	const { metadata, status, progress, phase_info } = milestone;

	lines.push(`# Milestone: ${metadata.title} (v${metadata.version})`);
	lines.push("");
	lines.push(`**Status:** ${status}`);
	lines.push(
		`**Progress:** ${progress.complete_phases}/${progress.total_phases} phases complete`,
	);
	lines.push(`**Created:** ${metadata.created}`);
	lines.push(`**Updated:** ${metadata.updated}`);
	if (metadata.archived_at) {
		lines.push(`**Archived:** ${metadata.archived_at}`);
	}
	if (metadata.git_tag) {
		lines.push(`**Git Tag:** ${metadata.git_tag}`);
	}
	lines.push("");

	// Phase details
	lines.push("## Phases");
	lines.push("");

	if (phase_info.length === 0) {
		lines.push("(No phases registered)");
	} else {
		for (const phase of phase_info) {
			const stateIcon =
				phase.state === "complete"
					? "✓"
					: phase.state === "active"
						? "●"
						: phase.state === "verifying"
							? "◑"
							: "○";
			lines.push(
				`${stateIcon} Phase ${phase.id}: ${phase.name} [${phase.state}]`,
			);
			lines.push(
				`   Plans: ${phase.progress.complete}/${phase.progress.total} complete`,
			);
		}
	}
	lines.push("");

	// Statistics
	const stats = getMilestoneStats(metadata.version);
	if (stats) {
		lines.push("## Statistics");
		lines.push("");
		lines.push(`- Total Plans: ${stats.total_plans}`);
		lines.push(`- Completed Plans: ${stats.completed_plans}`);
		lines.push(`- Active Plans: ${stats.active_plans}`);
		lines.push(`- Total Tracks: ${stats.total_tracks}`);
		if (stats.duration_days !== undefined) {
			lines.push(`- Duration: ${stats.duration_days} days`);
		}
	}
	lines.push("");

	// Next steps
	lines.push("## Next Steps");
	lines.push("");

	switch (status) {
		case "planning":
			lines.push("1. Continue planning phases");
			lines.push("2. Activate and execute plans");
			break;
		case "active":
			lines.push("1. Complete active phases");
			lines.push("2. Verify completed work");
			break;
		case "verifying":
			lines.push("1. Complete verification on all phases");
			lines.push("2. Resolve any issues");
			break;
		case "ready":
			lines.push("Ready for release!");
			lines.push(
				`Run: tiller milestone complete ${metadata.version} --tag`,
			);
			break;
		case "archived":
			lines.push(
				"Milestone archived. Create a new milestone for next release.",
			);
			break;
	}

	return lines.join("\n");
}

export function registerMilestoneCommands(program: Command): void {
	const milestone = program
		.command("milestone")
		.description("Version-based release management");

	// ============================================
	// milestone create - Create a new milestone
	// ============================================
	milestone
		.command("create <version>")
		.description("Create a new milestone")
		.option("-t, --title <title>", "Milestone title")
		.option(
			"-p, --phases <phases>",
			"Comma-separated phase IDs (e.g., '01,01.1,02')",
		)
		.option("--from-roadmap", "Infer from ROADMAP.md structure")
		.option("--set-current", "Set as current milestone (default if first)")
		.option("--json", "Output as JSON")
		.option("--dry-run", "Show what would be created")
		.action(
			(
				version: string,
				options: {
					title?: string;
					phases?: string;
					fromRoadmap?: boolean;
					setCurrent?: boolean;
					json?: boolean;
					dryRun?: boolean;
				},
			) => {
				let title = options.title;
				let phases: string[] = [];

				// Parse phases
				if (options.phases) {
					phases = options.phases.split(",").map((p) => p.trim());
				} else if (options.fromRoadmap) {
					const suggested = suggestMilestoneFromRoadmap();
					if (!suggested) {
						console.error(
							"Error: Could not parse milestones from ROADMAP.md",
						);
						console.error(
							"Provide phases with --phases or ensure ROADMAP.md has milestone sections",
						);
						process.exit(1);
					}
					title = title ?? suggested.title;
					phases = suggested.phases;
				}

				// Require title
				if (!title) {
					console.error("Error: --title is required");
					console.error(
						"Or use --from-roadmap to infer from ROADMAP.md",
					);
					process.exit(1);
				}

				// Dry run
				if (options.dryRun) {
					console.log("\n## Milestone Creation Plan\n");
					console.log(`Version: ${version}`);
					console.log(`Title: ${title}`);
					console.log(`Phases: ${phases.join(", ") || "(none)"}`);
					console.log("\n--dry-run: No changes made");
					return;
				}

				try {
					const ms = createMilestone(version, title, phases);

					if (options.setCurrent) {
						setCurrentMilestone(version);
					}

					if (options.json) {
						outputTOON({
							milestone: {
								created: true,
								version: ms.metadata.version,
								title: ms.metadata.title,
								phases: ms.metadata.phases,
								status: ms.status,
							},
						});
					} else {
						console.log(
							`✓ Milestone created: v${ms.metadata.version} (${ms.metadata.title})`,
						);
						console.log(`  Phases: ${phases.join(", ") || "(none)"}`);
						console.log(`  Status: ${ms.status}`);
						console.log("");
						console.log("Next steps:");
						console.log(
							`  - Add phases: tiller milestone update ${version} --phases "01,02,03"`,
						);
						console.log(
							`  - View status: tiller milestone status ${version}`,
						);
					}
				} catch (err) {
					console.error(
						`Error: ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exit(1);
				}
			},
		);

	// ============================================
	// milestone list - List all milestones
	// ============================================
	milestone
		.command("list")
		.description("List all milestones")
		.option("--archived", "Include archived milestones")
		.option("--json", "Output as JSON")
		.action((options: { archived?: boolean; json?: boolean }) => {
			const milestones = listMilestones();
			const archived = options.archived ? listArchivedMilestones() : [];
			const current = getCurrentMilestone();

			if (options.json) {
				outputTOON({
					milestones: {
						current: current?.metadata.version ?? null,
						active: milestones
							.filter((m) => m.status !== "archived")
							.map((m) => ({
								version: m.metadata.version,
								title: m.metadata.title,
								status: m.status,
								phases: m.metadata.phases,
								progress: m.progress,
							})),
						archived: archived.map((a) => ({
							version: a.version,
							path: a.path,
						})),
					},
				});
				return;
			}

			if (milestones.length === 0 && archived.length === 0) {
				console.log("No milestones found.");
				console.log("");
				console.log("Create one with:");
				console.log('  tiller milestone create 1.0 --title "My Milestone"');
				console.log("");
				console.log("Or parse from ROADMAP.md:");
				console.log("  tiller milestone create 1.0 --from-roadmap");
				return;
			}

			// Show current milestone first
			if (current && current.status !== "archived") {
				console.log("Current Milestone:");
				console.log("".padEnd(50, "─"));
				console.log(formatMilestoneListItem(current));
				console.log("");
			}

			// Show other active milestones
			const otherActive = milestones.filter(
				(m) =>
					m.status !== "archived" &&
					m.metadata.version !== current?.metadata.version,
			);

			if (otherActive.length > 0) {
				console.log("Other Milestones:");
				console.log("".padEnd(50, "─"));
				for (const ms of otherActive) {
					console.log(formatMilestoneListItem(ms));
					console.log("");
				}
			}

			// Show archived milestones
			if (archived.length > 0) {
				console.log("Archived Milestones:");
				console.log("".padEnd(50, "─"));
				for (const a of archived) {
					console.log(`□ ${a.version}`);
					console.log(`   Path: ${a.path}`);
					console.log("");
				}
			}
		});

	// ============================================
	// milestone status - Show milestone status
	// ============================================
	milestone
		.command("status [version]")
		.description("Show milestone status (defaults to current)")
		.option("--json", "Output as JSON")
		.option("--inject", "Format for prompt injection")
		.action(
			(
				version: string | undefined,
				options: { json?: boolean; inject?: boolean },
			) => {
				let ms: Milestone | null = null;

				if (version) {
					ms = getMilestone(version);
					if (!ms) {
						console.error(`Milestone not found: ${version}`);
						process.exit(2);
					}
				} else {
					ms = getCurrentMilestone();
					if (!ms) {
						console.log("No current milestone set.");
						console.log("");
						console.log("Create one with:");
						console.log(
							'  tiller milestone create 1.0 --title "My Milestone"',
						);
						return;
					}
				}

				if (options.inject) {
					console.log(formatMilestoneForInjection(ms));
					return;
				}

				if (options.json) {
					outputTOON({
						milestone: {
							metadata: ms.metadata,
							status: ms.status,
							progress: ms.progress,
							phases: ms.phase_info.map((p) => ({
								id: p.id,
								name: p.name,
								state: p.state,
								progress: p.progress,
							})),
						},
					});
					return;
				}

				console.log(formatMilestoneDetails(ms));
			},
		);

	// ============================================
	// milestone update - Update milestone metadata
	// ============================================
	milestone
		.command("update <version>")
		.description("Update milestone metadata")
		.option("-t, --title <title>", "New title")
		.option("-p, --phases <phases>", "New phases (comma-separated)")
		.option("--add-phases <phases>", "Add phases (comma-separated)")
		.option("--json", "Output as JSON")
		.action(
			(
				version: string,
				options: {
					title?: string;
					phases?: string;
					addPhases?: string;
					json?: boolean;
				},
			) => {
				const existing = getMilestone(version);
				if (!existing) {
					console.error(`Milestone not found: ${version}`);
					process.exit(2);
				}

				const updates: {
					title?: string;
					phases?: string[];
				} = {};

				if (options.title) {
					updates.title = options.title;
				}

				if (options.phases) {
					updates.phases = options.phases.split(",").map((p) => p.trim());
				} else if (options.addPhases) {
					const newPhases = options.addPhases.split(",").map((p) => p.trim());
					updates.phases = [...existing.metadata.phases, ...newPhases];
				}

				if (Object.keys(updates).length === 0) {
					console.error("No updates provided");
					console.error("Use --title, --phases, or --add-phases");
					process.exit(1);
				}

				const ms = updateMilestone(version, updates);
				if (!ms) {
					console.error(`Failed to update milestone: ${version}`);
					process.exit(1);
				}

				if (options.json) {
					outputTOON({
						milestone: {
							updated: true,
							version: ms.metadata.version,
							title: ms.metadata.title,
							phases: ms.metadata.phases,
						},
					});
				} else {
					console.log(`✓ Milestone updated: v${ms.metadata.version}`);
					if (updates.title) {
						console.log(`  Title: ${ms.metadata.title}`);
					}
					if (updates.phases) {
						console.log(`  Phases: ${ms.metadata.phases.join(", ")}`);
					}
				}
			},
		);

	// ============================================
	// milestone complete - Complete and archive
	// ============================================
	milestone
		.command("complete <version>")
		.description("Complete and archive a milestone")
		.option("--tag", "Create git tag v{version}")
		.option("--skip-verify", "Skip phase completion check")
		.option("--confirm", "Show confirmation TOON")
		.option("--no-confirm", "Skip confirmation")
		.option("--json", "Output as JSON")
		.action(
			(
				version: string,
				options: {
					tag?: boolean;
					skipVerify?: boolean;
					confirm?: boolean;
					json?: boolean;
				},
			) => {
				// Validate first
				const validation = canCompleteMilestone(version);
				if (!validation.ready && !options.skipVerify) {
					console.error(`Error: ${validation.reason}`);
					if (validation.incomplete_phases) {
						console.error("\nIncomplete phases:");
						for (const phase of validation.incomplete_phases) {
							console.error(`  - ${phase}`);
						}
					}
					console.error("\nUse --skip-verify to bypass this check");
					process.exit(1);
				}

				// Show confirmation if needed
				if (shouldConfirm(options)) {
					const toon = createConfirmation(
						"complete",
						`v${version}`,
						`Complete and archive milestone ${version}${options.tag ? " with git tag" : ""}`,
						`Complete milestone v${version}?`,
					);
					toon.confirmation.risk_level = "medium";
					toon.confirmation.options = [
						{
							label: `Yes, complete v${version}`,
							action: `tiller milestone complete ${version}${options.tag ? " --tag" : ""} --no-confirm`,
						},
						{ label: "No, cancel", action: null },
					];
					console.log(formatConfirmationTOON(toon));
					return;
				}

				try {
					const result = completeMilestone(version, {
						createTag: options.tag,
						skipValidation: options.skipVerify,
					});

					// Create git tag if requested
					if (options.tag && result.git_tag) {
						try {
							const tagMessage = `Release ${result.milestone.metadata.title} (${result.git_tag})`;
							execSync(
								`git tag -a ${result.git_tag} -m "${tagMessage}"`,
								{ stdio: "pipe" },
							);
						} catch (gitErr) {
							console.error(
								`Warning: Failed to create git tag: ${gitErr instanceof Error ? gitErr.message : String(gitErr)}`,
							);
						}
					}

					if (options.json) {
						outputTOON({
							milestone: {
								completed: true,
								version: result.milestone.metadata.version,
								archive_path: result.archive_path,
								git_tag: result.git_tag,
							},
						});
					} else {
						console.log(
							`✓ Milestone completed: v${result.milestone.metadata.version}`,
						);
						console.log(`  Archived to: ${result.archive_path}`);
						if (result.git_tag) {
							console.log(`  Git tag: ${result.git_tag}`);
							console.log("");
							console.log("To push the tag:");
							console.log(`  git push origin ${result.git_tag}`);
						}
					}
				} catch (err) {
					console.error(
						`Error: ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exit(1);
				}
			},
		);

	// ============================================
	// milestone set-current - Set current milestone
	// ============================================
	milestone
		.command("set-current <version>")
		.description("Set the current milestone")
		.option("--json", "Output as JSON")
		.action((version: string, options: { json?: boolean }) => {
			const ms = getMilestone(version);
			if (!ms) {
				console.error(`Milestone not found: ${version}`);
				process.exit(2);
			}

			try {
				setCurrentMilestone(version);

				if (options.json) {
					outputTOON({
						milestone: {
							current: version,
						},
					});
				} else {
					console.log(`✓ Current milestone set to: v${version}`);
				}
			} catch (err) {
				console.error(
					`Error: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
		});

	// ============================================
	// milestone delete - Delete a milestone
	// ============================================
	milestone
		.command("delete <version>")
		.description("Delete a milestone (does not delete phases)")
		.option("--confirm", "Show confirmation TOON")
		.option("--no-confirm", "Skip confirmation")
		.option("--json", "Output as JSON")
		.action(
			(
				version: string,
				options: { confirm?: boolean; json?: boolean },
			) => {
				const ms = getMilestone(version);
				if (!ms) {
					console.error(`Milestone not found: ${version}`);
					process.exit(2);
				}

				// Show confirmation if needed
				if (shouldConfirm(options)) {
					const toon = createConfirmation(
						"delete",
						`v${version}`,
						`Delete milestone registration (phases are not deleted)`,
						`Delete milestone v${version}?`,
					);
					toon.confirmation.risk_level = "medium";
					toon.confirmation.options = [
						{
							label: `Yes, delete v${version}`,
							action: `tiller milestone delete ${version} --no-confirm`,
						},
						{ label: "No, cancel", action: null },
					];
					console.log(formatConfirmationTOON(toon));
					return;
				}

				const deleted = deleteMilestone(version);

				if (options.json) {
					outputTOON({
						milestone: {
							deleted,
							version,
						},
					});
				} else {
					if (deleted) {
						console.log(`✓ Milestone deleted: v${version}`);
						console.log("  Note: Phases and their files remain unchanged");
					} else {
						console.error(`Failed to delete milestone: ${version}`);
						process.exit(1);
					}
				}
			},
		);

	// ============================================
	// milestone discover - Parse from ROADMAP.md
	// ============================================
	milestone
		.command("discover")
		.description("Parse milestone structure from ROADMAP.md")
		.option("--json", "Output as JSON")
		.action((options: { json?: boolean }) => {
			const parsed = parseMilestonesFromRoadmap();

			if (options.json) {
				outputTOON({
					milestones: parsed.map((m) => ({
						title: m.title,
						is_current: m.isCurrent,
						phases: m.phases,
					})),
				});
				return;
			}

			if (parsed.length === 0) {
				console.log("No milestone sections found in ROADMAP.md");
				console.log("");
				console.log("Expected format:");
				console.log("  ### My Milestone (Current)");
				console.log("  - [ ] **Phase 1: Description**");
				console.log("  - [ ] **Phase 2: Description**");
				return;
			}

			console.log("Discovered Milestones from ROADMAP.md:");
			console.log("".padEnd(50, "─"));

			for (const ms of parsed) {
				const currentLabel = ms.isCurrent ? " (Current)" : "";
				console.log(`${ms.title}${currentLabel}`);
				console.log(`  Phases: ${ms.phases.join(", ") || "(none)"}`);
				console.log("");
			}

			console.log("To create a milestone from this:");
			const suggested = suggestMilestoneFromRoadmap();
			if (suggested) {
				console.log(
					`  tiller milestone create ${suggested.version} --from-roadmap`,
				);
			}
		});
}
