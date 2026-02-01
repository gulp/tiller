/**
 * E2E tests for Tiller todo command - Manage todo lifecycle
 *
 * Commands:
 * - todo sync   - Move completed todos to done/ based on beads state
 * - todo status - Show todo status summary
 * - todo pick   - Interactive todo selection via TOON output
 * - todo show   - Show full todo content
 * - todo work   - Mark todo as in-progress and move to done/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller todo commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	// Helper to create a todo file with frontmatter
	function createTodo(
		dir: string,
		filename: string,
		opts: {
			beads_task?: string;
			beads_epic?: string;
			title?: string;
			area?: string;
			created?: string;
		} = {},
	): void {
		mkdirSync(dir, { recursive: true });
		const frontmatter = [
			"---",
			opts.title ? `title: "${opts.title}"` : 'title: "Test Todo"',
			opts.area ? `area: ${opts.area}` : "",
			opts.created ? `created: ${opts.created}` : "",
			opts.beads_task ? `beads_task: ${opts.beads_task}` : "",
			opts.beads_epic ? `beads_epic: ${opts.beads_epic}` : "",
			"---",
			"",
			"## Problem",
			"",
			"Some task description.",
			"",
			"## Solution",
			"",
			"<!-- TODO: Describe the fix -->",
		]
			.filter(Boolean)
			.join("\n");

		writeFileSync(join(dir, filename), frontmatter);
	}

	describe("todo status", () => {
		it("shows zero counts when no todos exist", async () => {
			const result = await runTiller(["todo", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Pending: 0");
			expect(result.stdout).toContain("Done:    0");
			expect(result.stdout).toContain("Linked:  0");
		});

		it("counts pending todos", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task-1.md", { title: "First task" });
			createTodo(pendingDir, "task-2.md", { title: "Second task" });
			createTodo(pendingDir, "task-3.md", { title: "Third task" });

			const result = await runTiller(["todo", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Pending: 3");
		});

		it("counts done todos", async () => {
			const doneDir = join(testDir, ".planning/todos/done");
			createTodo(doneDir, "completed-1.md", { title: "Completed task" });
			createTodo(doneDir, "completed-2.md", { title: "Another completed" });

			const result = await runTiller(["todo", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Done:    2");
		});

		it("counts linked todos (with beads reference)", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "linked-task.md", { beads_task: "beads-123" });
			createTodo(pendingDir, "linked-epic.md", { beads_epic: "beads-456" });
			createTodo(pendingDir, "unlinked.md", { title: "No beads link" });

			const result = await runTiller(["todo", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Pending: 3");
			expect(result.stdout).toContain("Linked:  2");
		});

		it("uses custom directories with --pending-dir and --done-dir", async () => {
			const customPending = join(testDir, "custom/pending");
			const customDone = join(testDir, "custom/done");
			createTodo(customPending, "custom-task.md", { title: "Custom pending" });
			createTodo(customDone, "custom-done.md", { title: "Custom done" });

			const result = await runTiller(
				[
					"todo",
					"status",
					"--pending-dir",
					"custom/pending",
					"--done-dir",
					"custom/done",
				],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Pending: 1");
			expect(result.stdout).toContain("Done:    1");
		});
	});

	describe("todo sync", () => {
		it("reports no pending directory when missing", async () => {
			const result = await runTiller(["todo", "sync"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No pending todos directory");
		});

		it("reports no todos to sync when all issues still open", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			// Create todo with non-existent beads issue (will be treated as "not closed")
			createTodo(pendingDir, "open-task.md", {
				beads_task: "beads-nonexistent",
			});

			const result = await runTiller(["todo", "sync"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No todos to sync");
		});

		it("skips todos without beads link", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "unlinked.md", { title: "No beads link" });

			const result = await runTiller(["todo", "sync"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Skipped 1 todo(s) with no beads link");
		});

		it("--dry-run shows what would be moved without changes", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task.md", { beads_task: "beads-123" });

			const result = await runTiller(["todo", "sync", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// File should still be in pending (not moved)
			expect(existsSync(join(pendingDir, "task.md"))).toBe(true);
		});

		it("uses custom directories with --pending-dir and --done-dir", async () => {
			const customPending = join(testDir, "my-todos/pending");
			createTodo(customPending, "my-task.md", { title: "Custom location" });

			const result = await runTiller(
				[
					"todo",
					"sync",
					"--pending-dir",
					"my-todos/pending",
					"--done-dir",
					"my-todos/done",
				],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("tiller todo sync");
		});

		it("creates done directory if it does not exist", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			const doneDir = join(testDir, ".planning/todos/done");
			createTodo(pendingDir, "task.md", { title: "Task without done dir" });

			// done/ doesn't exist yet
			expect(existsSync(doneDir)).toBe(false);

			await runTiller(["todo", "sync"], { cwd: testDir });

			// done/ should be created (even if no files moved)
			expect(existsSync(doneDir)).toBe(true);
		});
	});

	describe("todo pick", () => {
		it("reports no pending todos when directory is empty", async () => {
			const result = await runTiller(["todo", "pick", "--pretty"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No pending todos found");
		});

		it("lists pending todos with metadata in TOON format", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task-1.md", {
				title: "First task",
				area: "api",
				created: "2026-01-15",
			});
			createTodo(pendingDir, "task-2.md", {
				title: "Second task",
				area: "ui",
				created: "2026-01-16",
			});

			const result = await runTiller(["todo", "pick"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("```toon");
			expect(result.stdout).toContain("todo_pick:");
			expect(result.stdout).toContain("pending_count: 2");
			expect(result.stdout).toContain("First task");
			expect(result.stdout).toContain("Second task");
			expect(result.stdout).toContain("api");
			expect(result.stdout).toContain("ui");
		});

		it("lists pending todos in pretty format", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task-1.md", {
				title: "First task",
				area: "api",
			});

			const result = await runTiller(["todo", "pick", "--pretty"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("tiller todo pick");
			expect(result.stdout).toContain("1. First task [api]");
			expect(result.stdout).toContain("Next: tiller todo show <id>");
		});

		it("filters by area", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "api-task.md", { title: "API task", area: "api" });
			createTodo(pendingDir, "ui-task.md", { title: "UI task", area: "ui" });

			const result = await runTiller(["todo", "pick", "--area", "api"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("pending_count: 1");
			expect(result.stdout).toContain("API task");
			expect(result.stdout).not.toContain("UI task");
		});

		it("shows beads link when present", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "linked.md", {
				title: "Linked task",
				beads_task: "beads-abc123",
			});

			const result = await runTiller(["todo", "pick"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("beads-abc123");
		});

		it("supports --json output", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task.md", { title: "Test task" });

			const result = await runTiller(["todo", "pick", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json.todo_pick.pending_count).toBe(1);
			expect(json.todo_pick.todos[0].title).toBe("Test task");
		});
	});

	describe("todo show", () => {
		it("shows todo content in TOON format", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task-123.md", {
				title: "My task",
				area: "api",
				created: "2026-01-17",
				beads_task: "beads-xyz",
			});

			const result = await runTiller(["todo", "show", "task-123"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("```toon");
			expect(result.stdout).toContain("todo_show:");
			expect(result.stdout).toContain("My task");
			expect(result.stdout).toContain("area: api");
			expect(result.stdout).toContain("beads-xyz");
			expect(result.stdout).toContain("Problem");
		});

		it("shows todo content in pretty format", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task-456.md", {
				title: "Pretty task",
				area: "ui",
				created: "2026-01-17",
			});

			const result = await runTiller(["todo", "show", "task-456", "--pretty"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("# Pretty task");
			expect(result.stdout).toContain("**Area:** ui");
			expect(result.stdout).toContain("**Created:** 2026-01-17");
		});

		it("supports partial ID matching", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "2026-01-17-my-long-task-name.md", {
				title: "Long name task",
			});

			const result = await runTiller(["todo", "show", "my-long"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Long name task");
		});

		it("returns error when todo not found", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "existing.md", { title: "Existing" });

			const result = await runTiller(["todo", "show", "nonexistent"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Todo not found: nonexistent");
			expect(result.stderr).toContain("Available:");
		});

		it("includes actions in TOON output", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "task-abc.md", { title: "Action task" });

			const result = await runTiller(["todo", "show", "task-abc"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Work on it now");
			expect(result.stdout).toContain("Skip for now");
			expect(result.stdout).toContain("Brainstorm approach");
		});
	});

	describe("todo work", () => {
		it("moves todo from pending to done", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			const doneDir = join(testDir, ".planning/todos/done");
			createTodo(pendingDir, "work-task.md", { title: "Task to work on" });

			const result = await runTiller(["todo", "work", "work-task"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Started work on: Task to work on");
			expect(existsSync(join(pendingDir, "work-task.md"))).toBe(false);
			expect(existsSync(join(doneDir, "work-task.md"))).toBe(true);
		});

		it("--dry-run shows what would happen without moving", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "dry-task.md", { title: "Dry run task" });

			const result = await runTiller(["todo", "work", "dry-task", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Would move:");
			expect(existsSync(join(pendingDir, "dry-task.md"))).toBe(true);
		});

		it("creates done directory if it doesn't exist", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			const doneDir = join(testDir, ".planning/todos/done");
			createTodo(pendingDir, "new-done-task.md", { title: "New done dir task" });

			expect(existsSync(doneDir)).toBe(false);

			await runTiller(["todo", "work", "new-done-task"], { cwd: testDir });

			expect(existsSync(doneDir)).toBe(true);
			expect(existsSync(join(doneDir, "new-done-task.md"))).toBe(true);
		});

		it("returns error when todo not found", async () => {
			const result = await runTiller(["todo", "work", "missing"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Todo not found: missing");
		});

		it("shows beads update suggestion when linked", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			createTodo(pendingDir, "linked-work.md", {
				title: "Linked work task",
				beads_task: "beads-linked-123",
			});

			const result = await runTiller(["todo", "work", "linked-work"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("bd update beads-linked-123");
		});

		it("preserves file content when moving", async () => {
			const pendingDir = join(testDir, ".planning/todos/pending");
			const doneDir = join(testDir, ".planning/todos/done");
			createTodo(pendingDir, "content-task.md", {
				title: "Content preserved",
				area: "test",
			});

			await runTiller(["todo", "work", "content-task"], { cwd: testDir });

			const content = readFileSync(
				join(doneDir, "content-task.md"),
				"utf-8",
			);
			expect(content).toContain("Content preserved");
			expect(content).toContain("area: test");
		});
	});
});
