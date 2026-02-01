/**
 * E2E tests for Tiller workflow and step commands
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

// Helper to create valid workflow definition TOML
function createWorkflowToml(
	name: string,
	steps: { id: string; name: string; terminal?: boolean }[],
): string {
	const terminalSteps = steps
		.filter((s) => s.terminal)
		.map((s) => `"${s.id}"`)
		.join(", ");

	let toml = `# Test workflow
name = "${name}"
version = "1.0.0"
description = "Test workflow"
initial_step = "${steps[0].id}"
terminal_steps = [${terminalSteps || `"${steps[steps.length - 1].id}"`}]

`;
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		toml += `[steps.${step.id}]
name = "${step.name}"
description = "Step ${i + 1}"
outputs = []
`;
		// Add next step edge unless it's terminal
		if (i < steps.length - 1 && !step.terminal) {
			toml += `
[[steps.${step.id}.next]]
target = "${steps[i + 1].id}"
`;
		}
		toml += "\n";
	}
	return toml;
}

describe("tiller workflow commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("workflow start", () => {
		it("fails when workflow definition not found", async () => {
			const result = await runTiller(
				["workflow", "start", "nonexistent-workflow"],
				{ cwd: testDir },
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("not found");
		});

		it("starts a workflow from custom definition", async () => {
			const workflowsDir = join(testDir, ".tiller", "workflows");
			mkdirSync(workflowsDir, { recursive: true });

			const workflowContent = createWorkflowToml("test-workflow", [
				{ id: "step1", name: "First Step" },
				{ id: "step2", name: "Final Step", terminal: true },
			]);
			writeFileSync(join(workflowsDir, "test-workflow.toml"), workflowContent);

			const result = await runTiller(["workflow", "start", "test-workflow"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Started workflow");
			expect(result.stdout).toContain("test-workflow");
			expect(result.stdout).toContain("step1");
		});

		it("outputs JSON with --json flag", async () => {
			const workflowsDir = join(testDir, ".tiller", "workflows");
			mkdirSync(workflowsDir, { recursive: true });

			const workflowContent = createWorkflowToml("json-workflow", [
				{ id: "only", name: "Only Step", terminal: true },
			]);
			writeFileSync(join(workflowsDir, "json-workflow.toml"), workflowContent);

			const result = await runTiller(
				["workflow", "start", "json-workflow", "--json"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			expect(output).toHaveProperty("instance_id");
			expect(output).toHaveProperty("workflow", "json-workflow");
		});

		it("runs workflow in interactive mode with --interactive flag", async () => {
			const workflowsDir = join(testDir, ".tiller", "workflows");
			mkdirSync(workflowsDir, { recursive: true });

			// Create a workflow that starts at a terminal step (completes immediately)
			const workflowContent = createWorkflowToml("interactive-workflow", [
				{ id: "only", name: "Only Step", terminal: true },
			]);
			writeFileSync(
				join(workflowsDir, "interactive-workflow.toml"),
				workflowContent,
			);

			const result = await runTiller(
				["workflow", "start", "interactive-workflow", "--interactive"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("interactive-workflow");
			expect(result.stdout).toContain("Workflow completed");
		});
	});

	describe("workflow status", () => {
		it("reports no active workflow when none exists", async () => {
			const result = await runTiller(["workflow", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No active workflow");
		});
	});

	describe("workflow lifecycle", () => {
		it(
			"start -> status -> step next -> step done -> status (full lifecycle)",
			{ timeout: 30000 },
			async () => {
				// Create workflow with multiple steps
				const workflowsDir = join(testDir, ".tiller", "workflows");
				mkdirSync(workflowsDir, { recursive: true });

				const workflowContent = createWorkflowToml("lifecycle-workflow", [
					{ id: "start", name: "Start Step" },
					{ id: "middle", name: "Middle Step" },
					{ id: "end", name: "End Step", terminal: true },
				]);
				writeFileSync(
					join(workflowsDir, "lifecycle-workflow.toml"),
					workflowContent,
				);

				// Step 1: Start workflow
				const startResult = await runTiller(
					["workflow", "start", "lifecycle-workflow"],
					{ cwd: testDir },
				);
				expect(startResult.exitCode).toBe(0);
				expect(startResult.stdout).toContain("Started workflow");
				expect(startResult.stdout).toContain("start");

				// Step 2: Check status
				const statusResult = await runTiller(["workflow", "status"], {
					cwd: testDir,
				});
				expect(statusResult.exitCode).toBe(0);
				expect(statusResult.stdout).toContain("lifecycle-workflow");
				expect(statusResult.stdout).toContain("start");

				// Step 3: Check next step
				const nextResult = await runTiller(["step", "next"], { cwd: testDir });
				expect(nextResult.exitCode).toBe(0);
				expect(nextResult.stdout).toContain("start"); // Current step ID
				expect(nextResult.stdout).toContain("middle"); // Available transition

				// Step 4: Advance to middle
				const doneResult = await runTiller(["step", "done"], { cwd: testDir });
				expect(doneResult.exitCode).toBe(0);
				expect(doneResult.stdout).toContain("middle");

				// Step 5: Verify we're at middle
				const status2Result = await runTiller(["workflow", "status"], {
					cwd: testDir,
				});
				expect(status2Result.exitCode).toBe(0);
				expect(status2Result.stdout).toContain("middle");
			},
		);
	});

	describe("workflow resume", () => {
		it("resumes active workflow with context", { timeout: 20000 }, async () => {
			// Create and start workflow
			const workflowsDir = join(testDir, ".tiller", "workflows");
			mkdirSync(workflowsDir, { recursive: true });

			const workflowContent = createWorkflowToml("resume-workflow", [
				{ id: "step1", name: "Step One" },
				{ id: "step2", name: "Step Two", terminal: true },
			]);
			writeFileSync(
				join(workflowsDir, "resume-workflow.toml"),
				workflowContent,
			);
			await runTiller(["workflow", "start", "resume-workflow"], {
				cwd: testDir,
			});

			const result = await runTiller(["workflow", "resume"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resume-workflow");
			expect(result.stdout).toContain("step1");
		});

		it("reports no workflow when no active workflow exists", async () => {
			const result = await runTiller(["workflow", "resume"], { cwd: testDir });

			// Exits with error code when no workflow to resume
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toMatch(/no workflow|No workflow/i);
		});
	});
});

describe("tiller step commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("step next", () => {
		it("reports no active workflow when none exists", async () => {
			const result = await runTiller(["step", "next"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No active workflow");
		});

		it("fails for non-existent instance", async () => {
			const result = await runTiller(["step", "next", "nonexistent-instance"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("not found");
		});

		it("shows available transitions with --json", { timeout: 20000 }, async () => {
			// Create and start workflow
			const workflowsDir = join(testDir, ".tiller", "workflows");
			mkdirSync(workflowsDir, { recursive: true });

			const workflowContent = createWorkflowToml("next-workflow", [
				{ id: "step1", name: "Step One" },
				{ id: "step2", name: "Step Two", terminal: true },
			]);
			writeFileSync(join(workflowsDir, "next-workflow.toml"), workflowContent);
			await runTiller(["workflow", "start", "next-workflow"], { cwd: testDir });

			const result = await runTiller(["step", "next", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json).toHaveProperty("current_step");
			expect(json).toHaveProperty("available_transitions");
		});
	});

	describe("step done", () => {
		it("fails when no active workflow", async () => {
			const result = await runTiller(["step", "done"], { cwd: testDir });

			// Exits with error code when no workflow
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toMatch(/no active|No workflow/i);
		});

		it("advances to selected step with explicit target", { timeout: 20000 }, async () => {
			// Create workflow with branching
			const workflowsDir = join(testDir, ".tiller", "workflows");
			mkdirSync(workflowsDir, { recursive: true });

			// Create workflow where step1 can go to step2 or step3
			const workflowContent = `name = "branch-workflow"
version = "1.0.0"
description = "Branching workflow"
initial_step = "step1"
terminal_steps = ["step2", "step3"]

[steps.step1]
name = "Start"
description = "Starting point"
outputs = []

[[steps.step1.next]]
target = "step2"
label = "Path A"

[[steps.step1.next]]
target = "step3"
label = "Path B"

[steps.step2]
name = "Path A End"
description = "Terminal via A"
outputs = []

[steps.step3]
name = "Path B End"
description = "Terminal via B"
outputs = []
`;
			writeFileSync(
				join(workflowsDir, "branch-workflow.toml"),
				workflowContent,
			);
			await runTiller(["workflow", "start", "branch-workflow"], {
				cwd: testDir,
			});

			// Explicitly choose step3
			const result = await runTiller(["step", "done", "--to", "step3"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("step3");
		});
	});
});
