/**
 * E2E tests for Tiller repair command - Fix structural issues in planning artifacts
 *
 * Commands:
 * - repair all          - Run all repair subcommands
 * - repair numbering    - Detect/fix phase number collisions
 * - repair tracks       - Fix orphaned tracks, broken paths
 * - repair summaries    - Regenerate missing/malformed SUMMARY.md
 * - repair frontmatter  - Add missing required fields
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller repair command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("repair numbering", () => {
		it("reports no collisions when numbering is clean", async () => {
			// Create phases with unique numbers
			mkdirSync(join(testDir, ".planning/phases/01-first"), {
				recursive: true,
			});
			mkdirSync(join(testDir, ".planning/phases/02-second"), {
				recursive: true,
			});

			const result = await runTiller(["repair", "numbering"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("numbering");
		});

		it("detects phase number collisions", async () => {
			// Create phases with same number prefix
			mkdirSync(join(testDir, ".planning/phases/07-feature-a"), {
				recursive: true,
			});
			mkdirSync(join(testDir, ".planning/phases/07-feature-b"), {
				recursive: true,
			});

			const result = await runTiller(["repair", "numbering", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("collision");
		});

		it("detects plan reference collisions", async () => {
			// Create same plan ref in different directories
			const phaseDir1 = join(testDir, ".planning/phases/08-phase-a");
			const phaseDir2 = join(testDir, ".planning/phases/09-phase-b");
			mkdirSync(phaseDir1, { recursive: true });
			mkdirSync(phaseDir2, { recursive: true });

			writeFileSync(join(phaseDir1, "08-01-PLAN.md"), "# Plan A");
			writeFileSync(join(phaseDir2, "08-01-PLAN.md"), "# Plan B"); // Same ref

			const result = await runTiller(["repair", "numbering", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
		});

		it("outputs JSON with --json flag", async () => {
			mkdirSync(join(testDir, ".planning/phases/01-test"), { recursive: true });

			const result = await runTiller(["repair", "numbering", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json).toHaveProperty("subcommand", "numbering");
			expect(json).toHaveProperty("checked");
			expect(json).toHaveProperty("issues");
		});
	});

	describe("repair tracks", () => {
		it("reports no issues when tracks are healthy", async () => {
			const planPath = ".planning/phases/test/13-01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "13-01", "ready", { planPath });

			const result = await runTiller(["repair", "tracks"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("runs");
		});

		it("detects orphaned tracks with missing plan files", async () => {
			// Create track pointing to non-existent plan
			createMockTrack(testDir, "13-02", "ready", {
				planPath: ".planning/phases/missing/13-02-PLAN.md",
			});

			const result = await runTiller(["repair", "tracks", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("orphan");
		});

		it("outputs JSON with --json flag", async () => {
			const result = await runTiller(["repair", "tracks", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json).toHaveProperty("subcommand", "runs");
		});

		it("detects state drift with SUMMARY.done.md", async () => {
			// Create track with SUMMARY.done.md but state is not complete
			const planPath = "plans/test/13-03-phase/13-03-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "13-03", "ready", { planPath });

			// Create SUMMARY.done.md file
			const summaryPath = join(testDir, "plans/test/13-03-phase/13-03-SUMMARY.done.md");
			writeFileSync(summaryPath, "---\ntitle: Test\n---\n\n# Summary\n");

			const result = await runTiller(["repair", "tracks", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("state-drift");
			expect(result.stdout).toContain("SUMMARY.done.md");
		});

		it("detects state drift with SUMMARY.autopass.md", async () => {
			// Create track with SUMMARY.autopass.md but state is not verifying/passed
			const planPath = "plans/test/13-04-phase/13-04-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "13-04", "ready", { planPath });

			// Create SUMMARY.autopass.md file
			const summaryPath = join(testDir, "plans/test/13-04-phase/13-04-SUMMARY.autopass.md");
			writeFileSync(summaryPath, "---\ntitle: Test\n---\n\n# Summary\n");

			const result = await runTiller(["repair", "tracks", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("state-drift");
			expect(result.stdout).toContain("SUMMARY.autopass.md");
		});

		it("fixes state drift when using --execute", async () => {
			// Create track with SUMMARY.done.md but state is ready
			const planPath = "plans/test/13-05-phase/13-05-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "13-05", "ready", { planPath });

			// Create SUMMARY.done.md file
			const summaryPath = join(testDir, "plans/test/13-05-phase/13-05-SUMMARY.done.md");
			writeFileSync(summaryPath, "---\ntitle: Test\n---\n\n# Summary\n");

			const result = await runTiller(["repair", "tracks", "--execute"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("state-drift");
			expect(result.stdout).toContain("✓"); // Fixed indicator
		});
	});

	describe("repair frontmatter", () => {
		it("reports no issues when frontmatter is complete", async () => {
			const planPath = ".planning/phases/test/13-03-PLAN.md";
			const content = `---
phase: test
plan: 03
type: execute
title: Complete frontmatter
---

# Test Plan
`;
			createMockPlan(testDir, planPath, content);

			const result = await runTiller(["repair", "frontmatter"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
		});

		it("detects missing frontmatter fields", async () => {
			const planPath = ".planning/phases/test/13-04-PLAN.md";
			const content = `---
title: Missing fields
---

# Test Plan
`;
			createMockPlan(testDir, planPath, content);

			const result = await runTiller(["repair", "frontmatter", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// Should detect missing phase, plan, type
		});

		it("outputs JSON with --json flag", async () => {
			const result = await runTiller(["repair", "frontmatter", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json).toHaveProperty("subcommand", "frontmatter");
		});
	});

	describe("repair all", () => {
		it("runs all repair subcommands", async () => {
			const planPath = ".planning/phases/test/13-05-PLAN.md";
			createMockPlan(testDir, planPath);

			const result = await runTiller(["repair", "all", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("numbering");
			expect(result.stdout).toContain("runs");
			expect(result.stdout).toContain("frontmatter");
		});

		it("outputs combined JSON with --json flag", async () => {
			const result = await runTiller(["repair", "all", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(Array.isArray(json)).toBe(true);
		});
	});

	describe("command options", () => {
		it("subcommands accept --dry-run flag", async () => {
			const result = await runTiller(["repair", "all", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--dry-run");
		});

		it("subcommands accept --json flag", async () => {
			const result = await runTiller(["repair", "all", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--json");
		});

		it("has 'all' subcommand", async () => {
			const result = await runTiller(["repair", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("all");
		});
	});
});
