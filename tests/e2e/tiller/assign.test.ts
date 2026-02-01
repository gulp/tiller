/**
 * E2E tests for Tiller assign command - Assign plans to mates
 *
 * Usage: tiller assign <plan-ref> --to <mate>
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

describe("tiller assign command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create mates directory
		mkdirSync(join(testDir, ".tiller", "mates"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("basic assignment", () => {
		it("assigns a plan to an existing mate", async () => {
			// Create plan and track
			const planPath = ".planning/phases/test/09-01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-01", "ready", {
				planPath,
				intent: "Test assignment feature",
			});

			// Create mate
			await runTiller(["mate", "add", "worker-a"], { cwd: testDir });

			// Assign plan to mate
			const result = await runTiller(["assign", "09-01", "--to", "worker-a"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assigned");
			expect(result.stdout).toContain("09-01");
			expect(result.stdout).toContain("worker-a");

			// Verify mate has assigned plan
			const mateFile = join(testDir, ".tiller", "mates", "worker-a.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			expect(mate.assignedPlan).toContain("09-01");
		});

		it("shows plan intent in assignment output", async () => {
			const planPath = ".planning/phases/test/09-02-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-02", "ready", {
				planPath,
				intent: "Implement user authentication",
			});

			await runTiller(["mate", "add", "worker-b"], { cwd: testDir });

			const result = await runTiller(["assign", "09-02", "--to", "worker-b"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Plan:");
			// Should show intent or plan ref
		});
	});

	describe("error handling", () => {
		it("fails when plan does not exist", async () => {
			await runTiller(["mate", "add", "orphan-worker"], { cwd: testDir });

			const result = await runTiller(
				["assign", "nonexistent-plan", "--to", "orphan-worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Plan not found");
			expect(result.stderr).toContain("tiller list");
		});

		it("fails when mate does not exist (without --create-mate)", async () => {
			const planPath = ".planning/phases/test/09-03-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-03", "ready", { planPath });

			const result = await runTiller(
				["assign", "09-03", "--to", "ghost-worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Mate not found: ghost-worker");
			expect(result.stderr).toContain("--create-mate");
		});

		it("fails when mate is currently sailing", async () => {
			const planPath = ".planning/phases/test/09-04-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-04", "ready", { planPath });

			// Create mate in sailing state
			await runTiller(["mate", "add", "busy-worker"], { cwd: testDir });
			const mateFile = join(testDir, ".tiller", "mates", "busy-worker.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.state = "sailing";
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(
				["assign", "09-04", "--to", "busy-worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("currently sailing");
			expect(result.stderr).toContain("Wait for completion");
		});
	});

	describe("--create-mate flag", () => {
		it("creates mate if it does not exist", async () => {
			const planPath = ".planning/phases/test/09-05-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-05", "ready", { planPath });

			const result = await runTiller(
				["assign", "09-05", "--to", "new-worker", "--create-mate"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created mate: new-worker");
			expect(result.stdout).toContain("Assigned");

			// Verify mate was created and has plan
			const mateFile = join(testDir, ".tiller", "mates", "new-worker.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			expect(mate.name).toBe("new-worker");
			expect(mate.assignedPlan).toContain("09-05");
		});

		it("uses existing mate when --create-mate provided but mate exists", async () => {
			const planPath = ".planning/phases/test/09-06-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-06", "ready", { planPath });

			await runTiller(["mate", "add", "existing-worker"], { cwd: testDir });

			const result = await runTiller(
				["assign", "09-06", "--to", "existing-worker", "--create-mate"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Created mate");
			expect(result.stdout).toContain("Assigned");
		});
	});

	describe("mate state preservation", () => {
		it("preserves claimed state when assigning to claimed mate", async () => {
			const planPath = ".planning/phases/test/09-07-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-07", "ready", { planPath });

			// Create and claim mate
			await runTiller(["mate", "add", "claimed-worker"], { cwd: testDir });
			const mateFile = join(testDir, ".tiller", "mates", "claimed-worker.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.state = "claimed";
			mate.claimedBy = process.pid;
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(
				["assign", "09-07", "--to", "claimed-worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Mate state: claimed");
			expect(result.stdout).toContain("tiller sail");

			// Verify state preserved
			const updatedMate = JSON.parse(readFileSync(mateFile, "utf-8"));
			expect(updatedMate.state).toBe("claimed");
		});

		it("keeps available state when assigning to unclaimed mate", async () => {
			const planPath = ".planning/phases/test/09-08-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-08", "ready", { planPath });

			await runTiller(["mate", "add", "available-worker"], { cwd: testDir });

			const result = await runTiller(
				["assign", "09-08", "--to", "available-worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Mate state: available");
			expect(result.stdout).toContain("Waiting for mate to");
			expect(result.stdout).toContain("tiller claim");
		});
	});

	describe("plan ref resolution", () => {
		it("resolves full track reference", async () => {
			const planPath = ".planning/phases/test/09-09-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-09", "ready", { planPath });

			await runTiller(["mate", "add", "ref-worker"], { cwd: testDir });

			const result = await runTiller(
				["assign", "09-09", "--to", "ref-worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("09-09");
		});

		it("works with tracks in different states", async () => {
			// Test with approved track
			const planPath = ".planning/phases/test/09-10-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "09-10", "approved", { planPath });

			await runTiller(["mate", "add", "state-worker"], { cwd: testDir });

			const result = await runTiller(
				["assign", "09-10", "--to", "state-worker"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assigned");
		});
	});
});
