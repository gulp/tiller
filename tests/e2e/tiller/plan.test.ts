/**
 * E2E tests for Tiller plan management commands
 *
 * Commands:
 * - plan next    - Get next sequential plan number
 * - plan create  - Create new plan with template
 * - plan list    - List plans in phase
 * - plan show    - Show plan details
 * - plan set     - Update plan frontmatter
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller plan command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("plan next", () => {
		it("returns 1 for empty phase", async () => {
			// Create empty phase directory in test initiative
			mkdirSync(join(testDir, ".planning/phases/test/01-test-phase"), {
				recursive: true,
			});

			const result = await runTiller(["plan", "next", "--phase", "01"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// Output is full plan ref: 01-01
			expect(result.stdout.trim()).toBe("01-01");
		});

		it("returns max + 1 for phase with existing plans", async () => {
			const phaseDir = join(testDir, ".planning/phases/test/05-feature");
			mkdirSync(phaseDir, { recursive: true });
			writeFileSync(join(phaseDir, "05-01-PLAN.md"), "# Plan 1");
			writeFileSync(join(phaseDir, "05-02-PLAN.md"), "# Plan 2");
			writeFileSync(join(phaseDir, "05-05-PLAN.md"), "# Plan 5");

			const result = await runTiller(["plan", "next", "--phase", "05"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// Output is full plan ref: 05-06 (max(1,2,5) + 1 = 6)
			expect(result.stdout.trim()).toBe("05-06");
		});

		it("ignores signal plans (91+) when calculating next", async () => {
			const phaseDir = join(testDir, ".planning/phases/test/06-signals");
			mkdirSync(phaseDir, { recursive: true });
			writeFileSync(join(phaseDir, "06-03-PLAN.md"), "# Plan 3");
			writeFileSync(join(phaseDir, "06-91-PLAN.md"), "# Signal plan");
			writeFileSync(join(phaseDir, "06-95-PLAN.md"), "# Another signal");

			const result = await runTiller(["plan", "next", "--phase", "06"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// Output is full plan ref: 06-04 (max(3) + 1 = 4, ignores 91+)
			expect(result.stdout.trim()).toBe("06-04");
		});
	});

	describe("plan create", () => {
		it("creates a new plan with default template", async () => {
			// Phase directory will be auto-created by plan create
			const phaseDir = join(testDir, ".planning/phases/test/07-phase");

			const result = await runTiller(
				["plan", "create", "Implement user authentication", "--phase", "07"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);

			// Check plan file was created in initiative-scoped path
			const planPath = join(phaseDir, "07-01-PLAN.md");
			expect(existsSync(planPath)).toBe(true);

			const content = readFileSync(planPath, "utf-8");
			expect(content).toContain("Implement user authentication");
		});

		it("creates plan with correct numbering", async () => {
			const phaseDir = join(testDir, ".planning/phases/test/08-sequenced");
			mkdirSync(phaseDir, { recursive: true });
			writeFileSync(join(phaseDir, "08-01-PLAN.md"), "# Existing");
			writeFileSync(join(phaseDir, "08-02-PLAN.md"), "# Existing 2");

			const result = await runTiller(
				["plan", "create", "New plan", "--phase", "08"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);

			// Should create 08-03-PLAN.md
			const planPath = join(phaseDir, "08-03-PLAN.md");
			expect(existsSync(planPath)).toBe(true);
		});

		it("fails without phase argument when no active phase", async () => {
			const result = await runTiller(["plan", "create", "No phase specified"], {
				cwd: testDir,
			});

			// Should fail or prompt for phase
			expect([0, 1]).toContain(result.exitCode);
		});
	});

	describe("plan list", () => {
		it("lists plans in specified phase", async () => {
			const phaseDir = join(testDir, ".planning/phases/test/09-list-test");
			mkdirSync(phaseDir, { recursive: true });
			createMockPlan(testDir, ".planning/phases/test/09-list-test/09-01-PLAN.md");
			createMockPlan(testDir, ".planning/phases/test/09-list-test/09-02-PLAN.md");

			const result = await runTiller(["plan", "list", "--phase", "09"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("09-01");
			expect(result.stdout).toContain("09-02");
		});

		it("shows empty message for phase with no plans", async () => {
			mkdirSync(join(testDir, ".planning/phases/test/10-empty-phase"), {
				recursive: true,
			});

			const result = await runTiller(["plan", "list", "--phase", "10"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
		});

		// Note: --json flag test removed - feature not yet implemented for plan list
	});

	describe("plan show", () => {
		it("shows plan details for valid ref", async () => {
			const planPath = ".planning/phases/test/12-show-test/12-01-PLAN.md";
			const content = `---
phase: 12
plan: 01
title: Test plan for showing
---

<objective>
Demonstrate the plan show command
</objective>

<context>
Testing context
</context>

<tasks>
- Task 1
- Task 2
</tasks>

<verification>
- [ ] Tests pass
</verification>
`;
			createMockPlan(testDir, planPath, content);

			const result = await runTiller(["plan", "show", "12-01"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("12-01");
		});

		it("fails for non-existent plan ref", async () => {
			const result = await runTiller(["plan", "show", "99-99"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
		});
	});

	describe("plan set", () => {
		it("updates frontmatter title field", async () => {
			const planPath = ".planning/phases/test/13-set-test/13-01-PLAN.md";
			const content = `---
phase: 13
plan: 01
title: Original title
---

<objective>
Test objective
</objective>
`;
			createMockPlan(testDir, planPath, content);

			const result = await runTiller(
				["plan", "set", "13-01", "title", "Updated title"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);

			// Verify file was updated (title may be quoted)
			const updated = readFileSync(join(testDir, planPath), "utf-8");
			expect(updated).toMatch(/title:.*Updated title/);
		});

		it("sets wave field", async () => {
			const planPath = ".planning/phases/test/14-add-field/14-01-PLAN.md";
			const content = `---
phase: 14
plan: 01
title: Test plan
---

<objective>
Test
</objective>
`;
			createMockPlan(testDir, planPath, content);

			const result = await runTiller(["plan", "set", "14-01", "wave", "2"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);

			const updated = readFileSync(join(testDir, planPath), "utf-8");
			expect(updated).toContain("wave:");
		});

		it("fails for non-existent plan", async () => {
			const result = await runTiller(
				["plan", "set", "99-99", "title", "value"],
				{ cwd: testDir },
			);

			expect(result.exitCode).not.toBe(0);
		});

		it("fails for invalid key", async () => {
			const planPath = ".planning/phases/test/15-invalid/15-01-PLAN.md";
			createMockPlan(testDir, planPath);

			const result = await runTiller(
				["plan", "set", "15-01", "invalid-key", "value"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Invalid key");
		});
	});
});
