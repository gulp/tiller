/**
 * tiller todo - Manage .planning/todos/ lifecycle
 *
 * Subcommands:
 * - sync: Move completed todos to done/ based on beads state
 * - status: Show todo status summary
 * - pick: Interactive todo selection via TOON output
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { outputTOON } from "../types/toon.js";

interface TodoFrontmatter {
	beads_task?: string;
	beads_epic?: string;
	title?: string;
	area?: string;
	created?: string;
}

interface TodoItem {
	id: string; // filename without .md
	path: string;
	title: string;
	area?: string;
	created?: string;
	age: string; // relative age like "2d ago"
	beads_task?: string;
	beads_epic?: string;
}

function parseTodoFrontmatter(content: string): TodoFrontmatter {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};

	const fm: TodoFrontmatter = {};
	const lines = match[1].split("\n");
	for (const line of lines) {
		const [key, ...valueParts] = line.split(":");
		const value = valueParts.join(":").trim().replace(/^["']|["']$/g, ""); // Strip quotes
		if (key === "beads_task") fm.beads_task = value;
		if (key === "beads_epic") fm.beads_epic = value;
		if (key === "title") fm.title = value;
		if (key === "area") fm.area = value;
		if (key === "created") fm.created = value;
	}
	return fm;
}

/**
 * Calculate relative age string from date
 */
function getRelativeAge(dateStr: string | undefined, filePath: string): string {
	let date: Date;

	if (dateStr) {
		// Parse ISO date from frontmatter
		date = new Date(dateStr);
	} else {
		// Fall back to file modification time
		try {
			const stat = statSync(filePath);
			date = stat.mtime;
		} catch {
			return "unknown";
		}
	}

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays === 0) return "today";
	if (diffDays === 1) return "1d ago";
	if (diffDays < 7) return `${diffDays}d ago`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
	return `${Math.floor(diffDays / 30)}mo ago`;
}

/**
 * Load all pending todos with metadata
 */
function loadPendingTodos(pendingDir: string): TodoItem[] {
	if (!existsSync(pendingDir)) {
		return [];
	}

	const files = readdirSync(pendingDir).filter((f) => f.endsWith(".md"));
	const todos: TodoItem[] = [];

	for (const file of files) {
		const filePath = join(pendingDir, file);
		const content = readFileSync(filePath, "utf-8");
		const fm = parseTodoFrontmatter(content);

		const id = basename(file, ".md");
		todos.push({
			id,
			path: filePath,
			title: fm.title ?? id,
			area: fm.area,
			created: fm.created,
			age: getRelativeAge(fm.created, filePath),
			beads_task: fm.beads_task,
			beads_epic: fm.beads_epic,
		});
	}

	// Sort by created date (newest first)
	return todos.sort((a, b) => {
		if (!a.created && !b.created) return 0;
		if (!a.created) return 1;
		if (!b.created) return -1;
		return new Date(b.created).getTime() - new Date(a.created).getTime();
	});
}

function isBeadsClosed(issueId: string): boolean {
	try {
		// Try to get issue status from beads
		const result = execSync(`bd show ${issueId} 2>/dev/null`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Parse the output - look for status indicator
		// bd show format includes status like "[● P2 · CLOSED]" or "[● P2 · OPEN]"
		return result.includes("CLOSED") || result.includes("closed");
	} catch {
		return false; // If bd fails, assume not closed
	}
}

export function registerTodoCommands(program: Command): void {
	const todoCmd = program
		.command("todo")
		.description("Manage todo lifecycle with beads");

	todoCmd
		.command("sync")
		.description("Move completed todos to done/ based on beads state")
		.option("--dry-run", "Show what would be moved without changes")
		.option(
			"--pending-dir <dir>",
			"Pending todos directory (default: .planning/todos/pending)",
		)
		.option(
			"--done-dir <dir>",
			"Done todos directory (default: .planning/todos/done)",
		)
		.action(
			(options: {
				dryRun?: boolean;
				pendingDir?: string;
				doneDir?: string;
			}) => {
				const pendingDir = options.pendingDir ?? ".planning/todos/pending";
				const doneDir = options.doneDir ?? ".planning/todos/done";

				if (!existsSync(pendingDir)) {
					console.log(`No pending todos directory: ${pendingDir}`);
					return;
				}

				// Ensure done/ exists
				if (!options.dryRun) {
					mkdirSync(doneDir, { recursive: true });
				}

				const files = readdirSync(pendingDir).filter((f) => f.endsWith(".md"));
				let moved = 0;
				let skipped = 0;

				console.log("tiller todo sync");
				console.log("");

				for (const file of files) {
					const filePath = join(pendingDir, file);
					const content = readFileSync(filePath, "utf-8");
					const fm = parseTodoFrontmatter(content);

					const issueId = fm.beads_task ?? fm.beads_epic;
					if (!issueId) {
						skipped++;
						continue; // No linked beads issue
					}

					if (isBeadsClosed(issueId)) {
						if (options.dryRun) {
							console.log(`  Would move: ${file} (${issueId} closed)`);
						} else {
							renameSync(filePath, join(doneDir, file));
							console.log(`  ✓ Moved: ${file} → done/ (${issueId} closed)`);
						}
						moved++;
					}
				}

				console.log("");
				if (moved === 0) {
					console.log("No todos to sync (all linked issues still open)");
				} else {
					console.log(`Synced ${moved} todo(s)`);
				}
				if (skipped > 0) {
					console.log(`Skipped ${skipped} todo(s) with no beads link`);
				}
			},
		);

	todoCmd
		.command("status")
		.description("Show todo status summary")
		.option(
			"--pending-dir <dir>",
			"Pending todos directory (default: .planning/todos/pending)",
		)
		.option(
			"--done-dir <dir>",
			"Done todos directory (default: .planning/todos/done)",
		)
		.action((options: { pendingDir?: string; doneDir?: string }) => {
			const pendingDir = options.pendingDir ?? ".planning/todos/pending";
			const doneDir = options.doneDir ?? ".planning/todos/done";

			let pendingCount = 0;
			let doneCount = 0;
			let linkedCount = 0;

			if (existsSync(pendingDir)) {
				const files = readdirSync(pendingDir).filter((f) => f.endsWith(".md"));
				pendingCount = files.length;

				for (const file of files) {
					const content = readFileSync(join(pendingDir, file), "utf-8");
					const fm = parseTodoFrontmatter(content);
					if (fm.beads_task || fm.beads_epic) {
						linkedCount++;
					}
				}
			}

			if (existsSync(doneDir)) {
				doneCount = readdirSync(doneDir).filter((f) =>
					f.endsWith(".md"),
				).length;
			}

			console.log("tiller todo status");
			console.log("");
			console.log(`  Pending: ${pendingCount}`);
			console.log(`  Done:    ${doneCount}`);
			console.log(`  Linked:  ${linkedCount} (have beads reference)`);
		});

	todoCmd
		.command("pick")
		.description("Interactive todo selection via TOON output")
		.option(
			"--pending-dir <dir>",
			"Pending todos directory (default: .planning/todos/pending)",
		)
		.option("--area <area>", "Filter by area")
		.option("--pretty", "Pretty-print output for humans")
		.option("--json", "Output as JSON instead of TOON")
		.action(
			(options: {
				pendingDir?: string;
				area?: string;
				pretty?: boolean;
				json?: boolean;
			}) => {
				const pendingDir = options.pendingDir ?? ".planning/todos/pending";
				let todos = loadPendingTodos(pendingDir);

				// Filter by area if specified
				if (options.area) {
					todos = todos.filter(
						(t) => t.area?.toLowerCase() === options.area?.toLowerCase(),
					);
				}

				if (todos.length === 0) {
					if (options.pretty) {
						console.log("No pending todos found.");
						if (options.area) {
							console.log(`(filtered by area: ${options.area})`);
						}
						console.log("\nSuggestions:");
						console.log("  - Create a todo: tiller collect --todo");
						console.log("  - Check all areas: tiller todo pick");
					} else {
						outputTOON(
							{
								todo_pick: {
									pending_count: 0,
									area_filter: options.area ?? null,
									todos: [],
									suggestions: [
										"Create a todo with: tiller collect --todo",
										"Check all areas by removing --area filter",
									],
								},
							},
							{
								agent_hint:
									"No pending todos. Suggest creating one or continuing other work.",
							},
						);
					}
					return;
				}

				// Build TOON output for agent consumption
				const todoList = todos.map((t, idx) => ({
					index: idx + 1,
					id: t.id,
					title: t.title,
					area: t.area ?? "unset",
					age: t.age,
					beads_link: t.beads_task ?? t.beads_epic ?? null,
				}));

				const toonData = {
					todo_pick: {
						pending_count: todos.length,
						area_filter: options.area ?? null,
						todos: todoList,
						actions: {
							show: "tiller todo show <id>",
							work: "tiller todo work <id>",
							skip: "Return to list without action",
						},
						workflow: [
							"1. Present numbered list to user via AskUserQuestion",
							"2. After selection, run: tiller todo show <id>",
							"3. Based on todo content, offer: work on it, skip, or brainstorm",
						],
					},
				};

				if (options.pretty) {
					console.log("tiller todo pick");
					console.log("");
					console.log(`Found ${todos.length} pending todo(s):`);
					console.log("");
					for (const todo of todoList) {
						const areaTag = todo.area !== "unset" ? ` [${todo.area}]` : "";
						const beadsTag = todo.beads_link ? ` (${todo.beads_link})` : "";
						console.log(
							`  ${todo.index}. ${todo.title}${areaTag} - ${todo.age}${beadsTag}`,
						);
					}
					console.log("");
					console.log("Next: tiller todo show <id>");
				} else if (options.json) {
					console.log(JSON.stringify(toonData, null, 2));
				} else {
					outputTOON(toonData, {
						agent_hint:
							"Present todos as numbered list. Use AskUserQuestion to let user select. Then show selected todo details.",
					});
				}
			},
		);

	todoCmd
		.command("show <id>")
		.description("Show full todo content")
		.option(
			"--pending-dir <dir>",
			"Pending todos directory (default: .planning/todos/pending)",
		)
		.option("--pretty", "Pretty-print output for humans")
		.action((id: string, options: { pendingDir?: string; pretty?: boolean }) => {
			const pendingDir = options.pendingDir ?? ".planning/todos/pending";
			const todos = loadPendingTodos(pendingDir);
			const todo = todos.find((t) => t.id === id || t.id.includes(id));

			if (!todo) {
				console.error(`Todo not found: ${id}`);
				console.error(`Available: ${todos.map((t) => t.id).join(", ")}`);
				process.exit(1);
			}

			const content = readFileSync(todo.path, "utf-8");

			// Extract body (after frontmatter)
			const bodyMatch = content.match(/^---[\s\S]*?---\n([\s\S]*)$/);
			const body = bodyMatch ? bodyMatch[1].trim() : content;

			if (options.pretty) {
				console.log(`# ${todo.title}`);
				console.log("");
				console.log(`**Area:** ${todo.area ?? "unset"}`);
				console.log(`**Created:** ${todo.created ?? "unknown"} (${todo.age})`);
				if (todo.beads_task || todo.beads_epic) {
					console.log(`**Beads:** ${todo.beads_task ?? todo.beads_epic}`);
				}
				console.log("");
				console.log(body);
			} else {
				outputTOON(
					{
						todo_show: {
							id: todo.id,
							title: todo.title,
							area: todo.area ?? "unset",
							created: todo.created ?? null,
							age: todo.age,
							beads_link: todo.beads_task ?? todo.beads_epic ?? null,
							body,
							actions: [
								{
									label: "Work on it now",
									command: `tiller todo work ${todo.id}`,
									description:
										"Move to done/ and start working on this todo",
								},
								{
									label: "Skip for now",
									command: null,
									description: "Return to todo list",
								},
								{
									label: "Brainstorm approach",
									command: null,
									description: "Discuss solution before starting",
								},
							],
						},
					},
					{
						agent_hint:
							"Show todo content to user. Use AskUserQuestion to choose action: work on it, skip, or brainstorm.",
					},
				);
			}
		});

	todoCmd
		.command("work <id>")
		.description("Mark todo as in-progress and move to done/")
		.option(
			"--pending-dir <dir>",
			"Pending todos directory (default: .planning/todos/pending)",
		)
		.option(
			"--done-dir <dir>",
			"Done todos directory (default: .planning/todos/done)",
		)
		.option("--dry-run", "Show what would be done without making changes")
		.action(
			(
				id: string,
				options: { pendingDir?: string; doneDir?: string; dryRun?: boolean },
			) => {
				const pendingDir = options.pendingDir ?? ".planning/todos/pending";
				const doneDir = options.doneDir ?? ".planning/todos/done";
				const todos = loadPendingTodos(pendingDir);
				const todo = todos.find((t) => t.id === id || t.id.includes(id));

				if (!todo) {
					console.error(`Todo not found: ${id}`);
					console.error(`Available: ${todos.map((t) => t.id).join(", ")}`);
					process.exit(1);
				}

				if (options.dryRun) {
					console.log(`Would move: ${todo.id}.md → done/`);
					console.log(`Todo: ${todo.title}`);
					return;
				}

				// Ensure done/ exists
				mkdirSync(doneDir, { recursive: true });

				// Move todo to done/
				const destPath = join(doneDir, basename(todo.path));
				renameSync(todo.path, destPath);

				console.log(`✓ Started work on: ${todo.title}`);
				console.log(`  Moved to: ${destPath}`);
				console.log("");
				console.log("Next steps:");
				console.log("  - Begin implementing the solution");
				if (todo.beads_task) {
					console.log(`  - Update beads issue: bd update ${todo.beads_task} --status=in_progress`);
				}
			},
		);
}
