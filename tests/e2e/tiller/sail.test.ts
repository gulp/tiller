/**
 * E2E tests for Tiller sail command - Execute assigned plan
 *
 * Usage: tiller sail            (use assigned plan from claimed mate)
 *        tiller sail --plan X   (execute specific plan without mate)
 *        tiller sail --solo     (skip mate registration)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller sail command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create mates directory
		mkdirSync(join(testDir, ".tiller", "mates"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	// Helper to create a valid plan with tasks
	function createSailPlan(
		testDir: string,
		planPath: string,
		trackId: string,
	): void {
		const content = `---
phase: test
plan: ${trackId.split("-")[1] || "01"}
type: execute
---

<objective>
Execute the sail test plan with tasks.
</objective>

<tasks>
<task type="auto">
<name>Setup test environment</name>
<files>src/test.ts</files>
<action>Create test setup file</action>
</task>
<task type="checkpoint">
<name>Verify setup</name>
<files>src/test.ts</files>
<action>Ensure test file exists</action>
</task>
</tasks>

<verification>
- [ ] Build passes
- [ ] Tests pass
</verification>
`;
		createMockPlan(testDir, planPath, content);
	}

	describe("sail with --plan flag", () => {
		it("executes specific plan without mate", async () => {
			const planPath = ".planning/phases/test/10-01-PLAN.md";
			createSailPlan(testDir, planPath, "10-01");
			createMockTrack(testDir, "10-01", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-01", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Sailing: 10-01");
			expect(result.stdout).toContain("solo");
		});

		it("outputs TOON with plan data", async () => {
			const planPath = ".planning/phases/test/10-02-PLAN.md";
			createSailPlan(testDir, planPath, "10-02");
			createMockTrack(testDir, "10-02", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-02", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("```toon");
			expect(result.stdout).toContain("sail");
			expect(result.stdout).toContain("objective");
			expect(result.stdout).toContain("tasks");
		});

		it("parses tasks from PLAN.md", async () => {
			const planPath = ".planning/phases/test/10-03-PLAN.md";
			createSailPlan(testDir, planPath, "10-03");
			createMockTrack(testDir, "10-03", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-03", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// TOON should contain task data
			expect(result.stdout).toContain("Setup test environment");
			expect(result.stdout).toContain("Verify setup");
		});

		it("fails for non-existent plan", async () => {
			const result = await runTiller(
				["sail", "--plan", "ghost-plan", "--solo"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Plan not found");
		});
	});

	describe("sail --solo mode", () => {
		it("warns about untracked ephemeral work", async () => {
			const planPath = ".planning/phases/test/10-04-PLAN.md";
			createSailPlan(testDir, planPath, "10-04");
			createMockTrack(testDir, "10-04", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-04", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// Check for solo warning (might be in stderr or stdout)
			const output = result.stdout + result.stderr;
			expect(output).toContain("solo");
		});

		it("does not require mate for execution", async () => {
			const planPath = ".planning/phases/test/10-05-PLAN.md";
			createSailPlan(testDir, planPath, "10-05");
			createMockTrack(testDir, "10-05", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-05", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// The mate is in the TOON output (YAML format inside toon block)
			expect(result.stdout).toContain("mate: solo");
		});
	});

	describe("sail with mate", () => {
		it("uses mate assigned plan", async () => {
			const planPath = ".planning/phases/test/10-06-PLAN.md";
			createSailPlan(testDir, planPath, "10-06");
			createMockTrack(testDir, "10-06", "ready", { planPath });

			// Create mate with assigned plan
			await runTiller(["mate", "add", "sailor-1"], { cwd: testDir });
			const mateFile = join(testDir, ".tiller", "mates", "sailor-1.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.assignedPlan = "10-06";
			mate.state = "claimed";
			mate.claimedBy = process.pid;
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(["sail", "--mate", "sailor-1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Mate: sailor-1");
			expect(result.stdout).toContain("10-06");
		});

		it("updates mate state to sailing", async () => {
			const planPath = ".planning/phases/test/10-07-PLAN.md";
			createSailPlan(testDir, planPath, "10-07");
			createMockTrack(testDir, "10-07", "ready", { planPath });

			// Create mate with assigned plan
			await runTiller(["mate", "add", "sailor-2"], { cwd: testDir });
			const mateFile = join(testDir, ".tiller", "mates", "sailor-2.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.assignedPlan = "10-07";
			mate.state = "claimed";
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			await runTiller(["sail", "--mate", "sailor-2"], { cwd: testDir });

			// Verify mate state updated
			const updatedMate = JSON.parse(readFileSync(mateFile, "utf-8"));
			expect(updatedMate.state).toBe("sailing");
		});

		it("fails when mate has no assigned plan", async () => {
			await runTiller(["mate", "add", "unassigned-sailor"], { cwd: testDir });

			const result = await runTiller(["sail", "--mate", "unassigned-sailor"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("No plan assigned");
			expect(result.stderr).toContain("tiller assign");
		});

		it("fails when mate does not exist", async () => {
			const result = await runTiller(["sail", "--mate", "ghost-sailor"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Mate not found");
		});
	});

	describe("auto-activation", () => {
		it("auto-activates ready track on sail", async () => {
			const planPath = ".planning/phases/test/10-08-PLAN.md";
			createSailPlan(testDir, planPath, "10-08");
			createMockTrack(testDir, "10-08", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-08", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Auto-activated run");
			expect(result.stdout).toContain("active/executing");
		});

		it("fails to auto-activate approved track (needs import first)", async () => {
			// State machine requires approved → ready → active
			// sail cannot skip intermediate states
			const planPath = ".planning/phases/test/10-09-PLAN.md";
			createSailPlan(testDir, planPath, "10-09");
			createMockTrack(testDir, "10-09", "approved", { planPath });

			const result = await runTiller(["sail", "--plan", "10-09", "--solo"], {
				cwd: testDir,
			});

			// Should fail because approved → active/executing is not a valid transition
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Failed to activate");
		});

		it("fails to auto-activate proposed track (needs approval first)", async () => {
			// State machine requires proposed → approved → ready → active
			const planPath = ".planning/phases/test/10-10-PLAN.md";
			createSailPlan(testDir, planPath, "10-10");
			createMockTrack(testDir, "10-10", "proposed", { planPath });

			const result = await runTiller(["sail", "--plan", "10-10", "--solo"], {
				cwd: testDir,
			});

			// Should fail because proposed → active/executing is not a valid transition
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Failed to activate");
		});

		it("does not auto-activate already active track", async () => {
			const planPath = ".planning/phases/test/10-11-PLAN.md";
			createSailPlan(testDir, planPath, "10-11");
			createMockTrack(testDir, "10-11", "active/executing", { planPath });

			const result = await runTiller(["sail", "--plan", "10-11", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Auto-activated");
		});
	});

	describe("TOON output", () => {
		it("outputs verification steps from plan", async () => {
			const planPath = ".planning/phases/test/10-12-PLAN.md";
			createSailPlan(testDir, planPath, "10-12");
			createMockTrack(testDir, "10-12", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-12", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("verification");
			expect(result.stdout).toContain("Build passes");
			expect(result.stdout).toContain("Tests pass");
		});

		it("provides hint for next step", async () => {
			const planPath = ".planning/phases/test/10-13-PLAN.md";
			createSailPlan(testDir, planPath, "10-13");
			createMockTrack(testDir, "10-13", "ready", { planPath });

			const result = await runTiller(["sail", "--plan", "10-13", "--solo"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("tiller verify");
		});
	});

	describe("error handling without mate or plan", () => {
		it("fails with helpful message when no mate and no plan", async () => {
			const result = await runTiller(["sail"], { cwd: testDir });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("No mate");
			expect(result.stderr).toContain("--plan");
		});
	});
});
