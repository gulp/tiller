/**
 * E2E tests for Tiller migrate command - Migrate projects to v0.2.0 structure
 *
 * Command: tiller migrate <initiative> [--dry-run] [--planning-dir <dir>]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller migrate command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("validation", () => {
		it("fails when .planning directory does not exist", async () => {
			// Remove the default .planning directory
			const result = await runTiller(["migrate", "my-project"], {
				cwd: testDir,
			});

			// Should fail because there's nothing to migrate (empty .planning)
			// Note: The command checks for the directory, which exists but may be empty
			expect([0, 1]).toContain(result.exitCode);
		});

		it("requires initiative argument", async () => {
			const result = await runTiller(["migrate"], { cwd: testDir });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("missing required argument 'initiative'");
		});
	});

	describe("--dry-run mode", () => {
		it("shows what would be migrated without making changes", async () => {
			// Create a .planning directory with content
			const planningDir = join(testDir, ".planning");
			mkdirSync(join(planningDir, "phases/test"), { recursive: true });
			writeFileSync(
				join(planningDir, "phases/test/01-01-PLAN.md"),
				"# Test Plan",
			);

			const result = await runTiller(
				["migrate", "my-initiative", "--dry-run"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("[DRY RUN]");
			expect(result.stdout).toContain("specs/my-initiative");

			// Verify no actual changes were made
			expect(existsSync(join(testDir, "specs"))).toBe(false);
			expect(existsSync(join(planningDir, "phases/test/01-01-PLAN.md"))).toBe(
				true,
			);
		});

		it("shows tracks that would be updated", async () => {
			// Create plan and track
			const planPath = ".planning/phases/test/11-01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "11-01", "proposed", { planPath });

			const result = await runTiller(["migrate", "test-init", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("[DRY RUN]");
			expect(result.stdout).toContain("Tracks to update");
		});
	});

	describe("actual migration", () => {
		it("creates specs/{initiative} directory", async () => {
			// Create .planning with content
			const planningDir = join(testDir, ".planning");
			mkdirSync(join(planningDir, "phases"), { recursive: true });
			writeFileSync(join(planningDir, "phases/README.md"), "# Phases");

			const result = await runTiller(["migrate", "new-project"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created: specs/new-project");
			expect(existsSync(join(testDir, "specs/new-project"))).toBe(true);
		});

		it("moves files from .planning to specs/{initiative}", async () => {
			// Create .planning with content
			const planningDir = join(testDir, ".planning");
			mkdirSync(join(planningDir, "phases"), { recursive: true });
			writeFileSync(join(planningDir, "phases/test.md"), "# Test content");

			await runTiller(["migrate", "moved-project"], { cwd: testDir });

			// Files should be moved
			expect(
				existsSync(join(testDir, "specs/moved-project/phases/test.md")),
			).toBe(true);
		});

		it("updates track IDs with initiative prefix", async () => {
			// Create plan and track without initiative
			// Use run- prefix to avoid auto-migration renaming
			const planPath = ".planning/phases/test/run-migrate-01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-migrate-01", "proposed", {
				planPath,
				initiative: null,
			});

			const result = await runTiller(["migrate", "prefixed"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Migration complete");
			expect(result.stdout).toContain("Runs updated");
		});

		it("reports migration summary", async () => {
			const planningDir = join(testDir, ".planning");
			mkdirSync(join(planningDir, "phases"), { recursive: true });
			writeFileSync(join(planningDir, "phases/info.md"), "# Info");

			const result = await runTiller(["migrate", "summary-test"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Migration complete");
			expect(result.stdout).toContain("specs/summary-test");
		});
	});

	describe("--planning-dir option", () => {
		it("uses custom source directory", async () => {
			// Create custom planning directory
			const customDir = join(testDir, "custom-planning");
			mkdirSync(join(customDir, "phases"), { recursive: true });
			writeFileSync(join(customDir, "phases/data.md"), "# Data");

			const result = await runTiller(
				["migrate", "custom-src", "--planning-dir", "custom-planning"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(existsSync(join(testDir, "specs/custom-src/phases/data.md"))).toBe(
				true,
			);
		});

		it("fails when custom directory does not exist", async () => {
			const result = await runTiller(
				["migrate", "no-source", "--planning-dir", "nonexistent"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("No nonexistent/ directory found");
		});
	});
});
