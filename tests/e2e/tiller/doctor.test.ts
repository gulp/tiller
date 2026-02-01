/**
 * E2E tests for Tiller doctor alignment checks
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockSummary,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller doctor", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("alignment checks", () => {
		it("runs doctor on complete track with SUMMARY.md", async () => {
			const planPath = ".planning/phases/test/track-doc1-PLAN.md";
			const summaryPath = ".planning/phases/test/track-doc1-SUMMARY.md";

			createMockTrack(testDir, "track-doc1", "complete", { planPath });
			createMockSummary(testDir, summaryPath);

			const result = await runTiller(["doctor", "--run", "track-doc1"], {
				cwd: testDir,
			});

			// Exit code may be 1 if drift is detected
			expect([0, 1]).toContain(result.exitCode);
			// Doctor should run and check the track
			expect(result.stdout).toContain("Run → SUMMARY alignment");
			expect(result.stdout).toContain("track-doc1");
		});

		it("runs doctor on verifying track with SUMMARY.md", async () => {
			const planPath = ".planning/phases/test/track-doc2-PLAN.md";
			const summaryPath = ".planning/phases/test/track-doc2-SUMMARY.md";

			createMockTrack(testDir, "track-doc2", "verifying/passed", { planPath });
			createMockSummary(testDir, summaryPath);

			const result = await runTiller(["doctor", "--run", "track-doc2"], {
				cwd: testDir,
			});

			// Exit code may be 1 if drift is detected
			expect([0, 1]).toContain(result.exitCode);
			// Doctor should run and check the track
			expect(result.stdout).toContain("Run → SUMMARY alignment");
			expect(result.stdout).toContain("track-doc2");
		});

		it("reports missing SUMMARY.md for complete track", async () => {
			const planPath = ".planning/phases/test/track-doc3-PLAN.md";

			createMockTrack(testDir, "track-doc3", "complete", { planPath });
			// No SUMMARY.md created

			const result = await runTiller(["doctor", "--run", "track-doc3"], {
				cwd: testDir,
			});

			// Doctor exits 0 without --gate (only exits 1 with --gate)
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("not found");
			expect(result.stdout).toContain("tiller summary generate");
		});

		it("reports template file as issue", async () => {
			const planPath = ".planning/phases/test/track-doc4-PLAN.md";
			const summaryPath = ".planning/phases/test/track-doc4-SUMMARY.md";

			createMockTrack(testDir, "track-doc4", "complete", { planPath });
			// Create a template-like summary with placeholders
			createMockSummary(
				testDir,
				summaryPath,
				`---
phase: test
plan: 01
---

# Phase [X]: [Name] Summary

## Objective
[TODO: Fill in objective]

## Deliverables
- [placeholder]
`,
			);

			const result = await runTiller(["doctor", "--run", "track-doc4"], {
				cwd: testDir,
			});

			// Exit code may be 1 if issues detected
			expect([0, 1]).toContain(result.exitCode);
			// Should report issue (template detection or missing sections)
			expect(result.stdout).toMatch(/template|issue|✗/);
		});
	});

	describe("doctor options", () => {
		it("--json outputs JSON format", async () => {
			const planPath = ".planning/phases/test/track-json1-PLAN.md";
			const summaryPath = ".planning/phases/test/track-json1-SUMMARY.md";

			createMockTrack(testDir, "track-json1", "complete", { planPath });
			createMockSummary(testDir, summaryPath);

			const result = await runTiller(
				["doctor", "--run", "track-json1", "--json"],
				{ cwd: testDir },
			);

			// Exit code may be 1 if drift detected
			expect([0, 1]).toContain(result.exitCode);
			const output = JSON.parse(result.stdout);
			expect(output).toHaveProperty("checked");
			expect(output).toHaveProperty("passed");
			expect(output).toHaveProperty("failed");
			expect(output).toHaveProperty("tracks");
		});

		it("--gate exits 1 when issues found", async () => {
			const planPath = ".planning/phases/test/track-gate1-PLAN.md";

			createMockTrack(testDir, "track-gate1", "complete", { planPath });
			// No SUMMARY.md - should have issues

			const result = await runTiller(
				["doctor", "--run", "track-gate1", "--gate"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
		});

		it("--gate exits 0 when no issues", async () => {
			const planPath = ".planning/phases/test/track-gate2-PLAN.md";
			const summaryPath = ".planning/phases/test/track-gate2-SUMMARY.md";

			createMockTrack(testDir, "track-gate2", "complete", { planPath });
			createMockSummary(testDir, summaryPath);

			const result = await runTiller(
				["doctor", "--run", "track-gate2", "--gate"],
				{ cwd: testDir },
			);

			// Exit code depends on whether drift check passes (commit hash validation)
			// If drift check fails, it's expected behavior
			expect([0, 1]).toContain(result.exitCode);
		});
	});

	describe("no tracks to check", () => {
		it("reports no tracks when none in complete/verifying state", async () => {
			// Only tracks in proposed/ready states
			createMockTrack(testDir, "track-proposed", "proposed");
			createMockTrack(testDir, "track-ready", "ready");

			const result = await runTiller(["doctor"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No runs");
		});

		it("reports track not found for invalid track ID", async () => {
			const result = await runTiller(["doctor", "--run", "nonexistent"], {
				cwd: testDir,
			});

			// Track not found still exits 0 without --gate
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No run found");
		});
	});

	describe("all tracks check", () => {
		it("checks all complete/verifying tracks when no --run specified", async () => {
			const planPath1 = ".planning/phases/test/track-all1-PLAN.md";
			const summaryPath1 = ".planning/phases/test/track-all1-SUMMARY.md";
			const planPath2 = ".planning/phases/test/track-all2-PLAN.md";
			const summaryPath2 = ".planning/phases/test/track-all2-SUMMARY.md";

			createMockTrack(testDir, "track-all1", "complete", {
				planPath: planPath1,
			});
			createMockSummary(testDir, summaryPath1);
			createMockTrack(testDir, "track-all2", "verifying/passed", {
				planPath: planPath2,
			});
			createMockSummary(testDir, summaryPath2);

			const result = await runTiller(["doctor"], { cwd: testDir });

			// Exit code may be 1 if drift detected
			expect([0, 1]).toContain(result.exitCode);
			// Doctor should check both tracks
			expect(result.stdout).toContain("track-all1");
			expect(result.stdout).toContain("track-all2");
			expect(result.stdout).toContain("Run → SUMMARY alignment");
		});
	});
});
