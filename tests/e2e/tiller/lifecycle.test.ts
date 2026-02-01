/**
 * E2E tests for Tiller lifecycle state transitions
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockSummary,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller lifecycle", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("happy path transitions", () => {
		it("transitions proposed → approved", async () => {
			// Create track in proposed state
			createMockTrack(testDir, "track-test1", "proposed");

			// Approve the track (confirmation disabled in test env)
			const result = await runTiller(["approve", "track-test1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("approved");
		});

		it("transitions approved → ready via import", async () => {
			createMockTrack(testDir, "track-test2", "approved");

			const result = await runTiller(["import", "track-test2"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("ready");
		});

		it("transitions ready → active/executing via activate", async () => {
			createMockTrack(testDir, "track-test3", "ready");

			const result = await runTiller(["activate", "track-test3"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("activated");
			expect(result.stdout).toContain("active/executing");
		});

		it("transitions active/executing → active/paused via pause", async () => {
			// Create the plan directory for handoff file creation
			mkdirSync(join(testDir, ".planning/phases/test"), { recursive: true });
			createMockTrack(testDir, "track-test4", "active/executing");

			const result = await runTiller(["pause", "track-test4"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("paused");
		});

		it("transitions active/paused → active/executing via resume", async () => {
			createMockTrack(testDir, "track-test5", "active/paused");

			const result = await runTiller(["resume", "track-test5"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resumed");
		});

		it("transitions verifying/passed → complete", async () => {
			const planPath = ".planning/phases/test/track-test6-PLAN.md";
			// Use .done.md since verifying/passed means verification completed
			const summaryPath = ".planning/phases/test/track-test6-SUMMARY.done.md";

			createMockTrack(testDir, "track-test6", "verifying/passed", { planPath });
			createMockSummary(testDir, summaryPath);

			const result = await runTiller(["complete", "track-test6"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("completed");
		});

		it("auto-finalizes SUMMARY.md when verifying/passed (tiller-e87 regression)", async () => {
			// Bug tiller-e87: complete should auto-finalize SUMMARY.md → SUMMARY.done.md
			// when track is already in verifying/passed state, not ask to verify again
			const planPath = ".planning/phases/test/track-autofinalize-PLAN.md";
			const summaryDraftPath = ".planning/phases/test/track-autofinalize-SUMMARY.md";
			const summaryDonePath =
				".planning/phases/test/track-autofinalize-SUMMARY.done.md";

			// Create plan dir
			mkdirSync(join(testDir, ".planning/phases/test"), { recursive: true });

			// Create track in verifying/passed state
			createMockTrack(testDir, "track-autofinalize", "verifying/passed", {
				planPath,
			});

			// Create SUMMARY.md draft (not .done.md)
			createMockSummary(testDir, summaryDraftPath);

			// Set require-summary: true to trigger the check
			writeFileSync(
				join(testDir, ".tiller", "PRIME.md"),
				"require-summary: true\n",
			);

			// Run complete - should auto-finalize and succeed
			const result = await runTiller(["complete", "track-autofinalize"], {
				cwd: testDir,
			});

			// Should succeed (not ask to verify again)
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Finalizing summary");
			expect(result.stdout).toContain("Summary finalized");
			expect(result.stdout).toContain("completed");

			// Verify SUMMARY.done.md was created
			expect(existsSync(join(testDir, summaryDonePath))).toBe(true);
		});
	});

	describe("abandon transitions", () => {
		it("allows abandon from proposed state", async () => {
			createMockTrack(testDir, "track-abandon1", "proposed");

			const result = await runTiller(["abandon", "track-abandon1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("abandoned");
		});

		it("allows abandon from approved state", async () => {
			createMockTrack(testDir, "track-abandon2", "approved");

			const result = await runTiller(["abandon", "track-abandon2"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("abandoned");
		});

		it("allows abandon from ready state", async () => {
			createMockTrack(testDir, "track-abandon3", "ready");

			const result = await runTiller(["abandon", "track-abandon3"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("abandoned");
		});

		it("allows abandon from active/executing state", async () => {
			createMockTrack(testDir, "track-abandon4", "active/executing");

			const result = await runTiller(["abandon", "track-abandon4"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("abandoned");
		});

		it("prevents abandon from verifying state", async () => {
			createMockTrack(testDir, "track-abandon5", "verifying/testing");

			const result = await runTiller(["abandon", "track-abandon5"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Cannot abandon");
		});

		it("prevents abandon from complete state", async () => {
			createMockTrack(testDir, "track-abandon6", "complete");

			const result = await runTiller(["abandon", "track-abandon6"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("already");
		});
	});

	describe("invalid transitions", () => {
		it("rejects approve on non-proposed track", async () => {
			createMockTrack(testDir, "track-invalid1", "approved");

			const result = await runTiller(["approve", "track-invalid1"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Cannot approve");
		});

		it("rejects import on non-approved track", async () => {
			createMockTrack(testDir, "track-invalid2", "proposed");

			const result = await runTiller(["import", "track-invalid2"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Cannot import");
		});

		it("rejects activate on non-ready track", async () => {
			createMockTrack(testDir, "track-invalid3", "proposed");

			const result = await runTiller(["activate", "track-invalid3"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Cannot activate");
		});

		it("rejects pause on non-active/executing track", async () => {
			createMockTrack(testDir, "track-invalid4", "ready");

			const result = await runTiller(["pause", "track-invalid4"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Cannot pause");
		});

		it("rejects resume on non-active/paused track", async () => {
			createMockTrack(testDir, "track-invalid5", "active/executing");

			const result = await runTiller(["resume", "track-invalid5"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Cannot resume");
		});

		it("rejects complete on non-verifying/passed track", async () => {
			createMockTrack(testDir, "track-invalid6", "active/executing");

			const result = await runTiller(["complete", "track-invalid6"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			// Command returns TOON error indicating verification not started
			expect(result.stdout).toContain("Verification not started");
		});
	});

	describe("complete command flags", () => {
		it("complete --skip-summary bypasses SUMMARY.md check", async () => {
			createMockTrack(testDir, "track-skip1", "verifying/passed");
			// No SUMMARY.md created

			const result = await runTiller(
				["complete", "track-skip1", "--skip-summary"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("completed");
		});

		it("complete --force bypasses SUMMARY.md check from verifying/passed", async () => {
			// --force from verifying/passed bypasses SUMMARY.md check
			// Note: --force cannot bypass state machine - verifying/failed → complete is invalid
			createMockTrack(testDir, "track-force1", "verifying/passed");
			// No SUMMARY.md created

			const result = await runTiller(["complete", "track-force1", "--force"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("completed");
		});

		it("complete auto-generates SUMMARY.md when require-summary: true", async () => {
			// Create PLAN.md with title for auto-summary generation to work
			const planPath = ".planning/phases/test/track-nosummary-PLAN.md";
			const planDir = join(testDir, ".planning/phases/test");
			mkdirSync(planDir, { recursive: true });
			writeFileSync(
				join(testDir, planPath),
				`---
title: "Test plan for summary"
phase: 01
plan: 01
---

<objective>
Test objective
</objective>
`,
			);
			createMockTrack(testDir, "track-nosummary", "verifying/passed", {
				planPath,
			});
			// No SUMMARY.md created

			// Set require-summary: true in PRIME.md
			writeFileSync(
				join(testDir, ".tiller", "PRIME.md"),
				"require-summary: true\n",
			);

			const result = await runTiller(["complete", "track-nosummary"], {
				cwd: testDir,
			});

			// With require-summary: true, no SUMMARY.md, and verifying/passed state:
			// Should auto-generate AND auto-finalize (no verify needed)
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("SUMMARY.md generated");
			expect(result.stdout).toContain("Summary finalized");
			expect(result.stdout).toContain("completed");
		});

		it("complete from active state generates SUMMARY and asks to verify (tiller-7tj regression)", async () => {
			// Bug tiller-7tj: When track is NOT in verifying/passed state,
			// generating SUMMARY should ask to verify, not auto-finalize
			const planPath = ".planning/phases/test/track-active-summary-PLAN.md";
			const planDir = join(testDir, ".planning/phases/test");
			mkdirSync(planDir, { recursive: true });
			writeFileSync(
				join(testDir, planPath),
				`---
title: "Test active state summary"
phase: 01
plan: 01
---

<objective>
Test objective
</objective>
`,
			);
			createMockTrack(testDir, "track-active-summary", "active/executing", {
				planPath,
			});

			// Set require-summary: true
			writeFileSync(
				join(testDir, ".tiller", "PRIME.md"),
				"require-summary: true\n",
			);

			const result = await runTiller(["complete", "track-active-summary"], {
				cwd: testDir,
			});

			// Should fail because not verified yet (cannot complete from active without verification)
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain("Verification not started");
		});
	});

	describe("track not found", () => {
		it("returns error for non-existent track", async () => {
			const result = await runTiller(["approve", "nonexistent-track"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("pause/resume handoff", () => {
		it("pause creates .continue-here.md by default", async () => {
			const planPath = ".planning/phases/test/track-handoff1-PLAN.md";
			// Create the directory for the plan file (handoff is written adjacent to plan)
			mkdirSync(join(testDir, ".planning/phases/test"), { recursive: true });
			createMockTrack(testDir, "track-handoff1", "active/executing", { planPath });

			const result = await runTiller(["pause", "track-handoff1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("paused");
			expect(result.stdout).toContain("Handoff created");

			// Check .continue-here.md exists
			const handoffPath = join(testDir, ".planning/phases/test/.continue-here.md");
			expect(existsSync(handoffPath)).toBe(true);

			// Check content has required sections
			const content = readFileSync(handoffPath, "utf-8");
			expect(content).toContain("## Current State");
			expect(content).toContain("## Next Action");
		});

		it("pause with --context and --next preserves custom content", async () => {
			const planPath = ".planning/phases/test/track-handoff2-PLAN.md";
			mkdirSync(join(testDir, ".planning/phases/test"), { recursive: true });
			createMockTrack(testDir, "track-handoff2", "active/executing", { planPath });

			const result = await runTiller(
				[
					"pause",
					"track-handoff2",
					"--context",
					"Working on authentication module",
					"--next",
					"Complete the OAuth integration",
				],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);

			const handoffPath = join(testDir, ".planning/phases/test/.continue-here.md");
			const content = readFileSync(handoffPath, "utf-8");
			expect(content).toContain("Working on authentication module");
			expect(content).toContain("Complete the OAuth integration");
		});

		it("pause with --no-handoff skips .continue-here.md creation", async () => {
			const planPath = ".planning/phases/test/track-handoff3-PLAN.md";
			mkdirSync(join(testDir, ".planning/phases/test"), { recursive: true });
			createMockTrack(testDir, "track-handoff3", "active/executing", { planPath });

			const result = await runTiller(
				["pause", "track-handoff3", "--no-handoff"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("paused");
			expect(result.stdout).not.toContain("Handoff created");

			const handoffPath = join(testDir, ".planning/phases/test/.continue-here.md");
			expect(existsSync(handoffPath)).toBe(false);
		});

		it("resume deletes .continue-here.md by default", async () => {
			const planPath = ".planning/phases/test/track-handoff4-PLAN.md";
			mkdirSync(join(testDir, ".planning/phases/test"), { recursive: true });
			createMockTrack(testDir, "track-handoff4", "active/executing", { planPath });

			// First pause to create handoff
			await runTiller(["pause", "track-handoff4"], { cwd: testDir });

			const handoffPath = join(testDir, ".planning/phases/test/.continue-here.md");
			expect(existsSync(handoffPath)).toBe(true);

			// Now resume
			const result = await runTiller(["resume", "track-handoff4"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resumed");
			expect(result.stdout).toContain("Handoff cleaned up");
			expect(existsSync(handoffPath)).toBe(false);
		});

		it("resume with --keep-handoff preserves .continue-here.md", async () => {
			const planPath = ".planning/phases/test/track-handoff5-PLAN.md";
			mkdirSync(join(testDir, ".planning/phases/test"), { recursive: true });
			createMockTrack(testDir, "track-handoff5", "active/executing", { planPath });

			// First pause to create handoff
			await runTiller(["pause", "track-handoff5"], { cwd: testDir });

			const handoffPath = join(testDir, ".planning/phases/test/.continue-here.md");
			expect(existsSync(handoffPath)).toBe(true);

			// Resume with --keep-handoff
			const result = await runTiller(
				["resume", "track-handoff5", "--keep-handoff"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resumed");
			expect(result.stdout).not.toContain("Handoff cleaned up");
			expect(existsSync(handoffPath)).toBe(true);
		});
	});
});
