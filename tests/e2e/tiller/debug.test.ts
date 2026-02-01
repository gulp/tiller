/**
 * E2E tests for Tiller debug commands
 *
 * Tests the debug workflow:
 * - tiller debug start <title>
 * - tiller debug list
 * - tiller debug status [slug]
 * - tiller debug evidence <slug> <description>
 * - tiller debug hypothesis <slug> <description>
 * - tiller debug test <slug> <index>
 * - tiller debug root-cause <slug> <description>
 * - tiller debug fix <slug> <description>
 * - tiller debug resolve <slug>
 * - tiller debug abandon <slug>
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller debug", () => {
	let testDir: string;
	let debugDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		debugDir = join(testDir, ".planning", "debug");
		mkdirSync(debugDir, { recursive: true });
		mkdirSync(join(debugDir, "resolved"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("debug start", () => {
		it("creates a new debug session", async () => {
			const result = await runTiller(
				["debug", "start", "Test Bug", "--symptoms", "Something broke"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Debug session created");
			expect(result.stdout).toContain("test-bug");

			// Check file was created
			expect(existsSync(join(debugDir, "test-bug.md"))).toBe(true);
		});

		it("creates session with --json flag", async () => {
			const result = await runTiller(
				["debug", "start", "JSON Test", "--json"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("created");
			expect(result.stdout).toContain("json-test");
		});
	});

	describe("debug list", () => {
		it("shows message when no sessions exist", async () => {
			const result = await runTiller(["debug", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No debug sessions found");
		});

		it("lists active sessions", async () => {
			// Create a session first
			await runTiller(["debug", "start", "List Test Bug"], { cwd: testDir });

			const result = await runTiller(["debug", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Active Debug Sessions");
			expect(result.stdout).toContain("list-test-bug");
			expect(result.stdout).toContain("evidence-gathering");
		});

		it("shows sessions with --json flag", async () => {
			await runTiller(["debug", "start", "JSON List Test"], { cwd: testDir });

			const result = await runTiller(["debug", "list", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("debug_sessions");
			expect(result.stdout).toContain("active");
		});
	});

	describe("debug status", () => {
		it("shows session details", async () => {
			await runTiller(
				["debug", "start", "Status Test", "--symptoms", "Test symptom"],
				{ cwd: testDir },
			);

			const result = await runTiller(["debug", "status", "status-test"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Status Test");
			expect(result.stdout).toContain("evidence-gathering");
			expect(result.stdout).toContain("Symptoms");
		});

		it(
			"shows most recent session by default",
			async () => {
				await runTiller(["debug", "start", "First Session"], { cwd: testDir });
				await runTiller(["debug", "start", "Second Session"], { cwd: testDir });

				const result = await runTiller(["debug", "status"], { cwd: testDir });

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Second Session");
			},
			20000,
		);

		it("formats for prompt injection with --inject", async () => {
			await runTiller(["debug", "start", "Inject Test"], { cwd: testDir });

			const result = await runTiller(
				["debug", "status", "inject-test", "--inject"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("## Debug Session:");
			expect(result.stdout).toContain("**ID:**");
			expect(result.stdout).toContain("### Next Steps");
		});
	});

	describe("debug evidence", () => {
		it("adds evidence to session", async () => {
			await runTiller(["debug", "start", "Evidence Test"], { cwd: testDir });

			const result = await runTiller(
				[
					"debug",
					"evidence",
					"evidence-test",
					"Found null pointer in log",
					"--source",
					"server.log:42",
				],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Evidence added");
			expect(result.stdout).toContain("Total evidence: 1");
		});

		it("returns error for nonexistent session", async () => {
			const result = await runTiller(
				["debug", "evidence", "nonexistent", "Test"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("debug hypothesis", () => {
		it("adds hypothesis to session", async () => {
			await runTiller(["debug", "start", "Hypothesis Test"], { cwd: testDir });

			const result = await runTiller(
				["debug", "hypothesis", "hypothesis-test", "Memory leak in worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Hypothesis added");
			expect(result.stdout).toContain("Total hypotheses: 1");
		});
	});

	describe("debug test", () => {
		it("updates hypothesis test result", async () => {
			await runTiller(["debug", "start", "Test Hypothesis"], { cwd: testDir });
			await runTiller(
				["debug", "hypothesis", "test-hypothesis", "Memory leak"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				[
					"debug",
					"test",
					"test-hypothesis",
					"1",
					"--test",
					"Ran profiler",
					"--result",
					"No leak found",
					"--eliminate",
				],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Hypothesis 1 updated");
			expect(result.stdout).toContain("eliminated");
		});

		it("confirms hypothesis", async () => {
			await runTiller(["debug", "start", "Confirm Hypo"], { cwd: testDir });
			await runTiller(
				["debug", "hypothesis", "confirm-hypo", "Race condition"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				[
					"debug",
					"test",
					"confirm-hypo",
					"1",
					"--test",
					"Added logging",
					"--confirm",
				],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("confirmed");
		});
	});

	describe("debug root-cause", () => {
		it("confirms root cause and updates status", async () => {
			await runTiller(["debug", "start", "Root Cause Test"], { cwd: testDir });

			const result = await runTiller(
				["debug", "root-cause", "root-cause-test", "Race condition in handler"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Root cause confirmed");
			expect(result.stdout).toContain("root-cause-confirmed");
		});
	});

	describe("debug fix", () => {
		it("records fix applied", async () => {
			await runTiller(["debug", "start", "Fix Test"], { cwd: testDir });

			const result = await runTiller(
				["debug", "fix", "fix-test", "Added mutex lock"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Fix recorded");
		});
	});

	describe("debug resolve", () => {
		it("resolves session and moves to resolved directory", async () => {
			await runTiller(["debug", "start", "Resolve Test"], { cwd: testDir });

			const result = await runTiller(
				["debug", "resolve", "resolve-test", "--verify", "Tested in production"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resolved");
			expect(result.stdout).toContain("resolved/resolve-test.md");

			// Active file should be gone
			expect(existsSync(join(debugDir, "resolve-test.md"))).toBe(false);
			// Resolved file should exist
			expect(existsSync(join(debugDir, "resolved", "resolve-test.md"))).toBe(
				true,
			);
		});
	});

	describe("debug abandon", () => {
		it("abandons session with reason", async () => {
			await runTiller(["debug", "start", "Abandon Test"], { cwd: testDir });

			const result = await runTiller(
				[
					"debug",
					"abandon",
					"abandon-test",
					"--reason",
					"No longer reproducible",
				],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("abandoned");
			expect(result.stdout).toContain("No longer reproducible");
			expect(result.stdout).toContain("resolved/abandon-test.md");
		});
	});

	describe("debug workflow", () => {
		it("supports full debugging workflow", { timeout: 60000 }, async () => {
			// 1. Start session
			let result = await runTiller(
				["debug", "start", "Workflow Test", "--symptoms", "API returns 500"],
				{ cwd: testDir },
			);
			expect(result.exitCode).toBe(0);

			// 2. Add evidence
			result = await runTiller(
				[
					"debug",
					"evidence",
					"workflow-test",
					"Stack trace in logs",
					"--source",
					"api.log",
				],
				{ cwd: testDir },
			);
			expect(result.exitCode).toBe(0);

			// 3. Form hypothesis
			result = await runTiller(
				["debug", "hypothesis", "workflow-test", "Database timeout"],
				{ cwd: testDir },
			);
			expect(result.exitCode).toBe(0);

			// 4. Test hypothesis
			result = await runTiller(
				[
					"debug",
					"test",
					"workflow-test",
					"1",
					"--test",
					"Checked DB metrics",
					"--result",
					"Timeout confirmed",
					"--confirm",
				],
				{ cwd: testDir },
			);
			expect(result.exitCode).toBe(0);

			// 5. Confirm root cause
			result = await runTiller(
				[
					"debug",
					"root-cause",
					"workflow-test",
					"Database connection pool exhausted",
				],
				{ cwd: testDir },
			);
			expect(result.exitCode).toBe(0);

			// 6. Record fix
			result = await runTiller(
				["debug", "fix", "workflow-test", "Increased connection pool size"],
				{ cwd: testDir },
			);
			expect(result.exitCode).toBe(0);

			// 7. Resolve
			result = await runTiller(
				[
					"debug",
					"resolve",
					"workflow-test",
					"--verify",
					"Tested with load test, no more 500s",
				],
				{ cwd: testDir },
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resolved");
		});
	});
});
