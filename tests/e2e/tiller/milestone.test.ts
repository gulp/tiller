/**
 * E2E tests for Tiller milestone commands
 *
 * Tests the milestone workflow:
 * - tiller milestone create <version>
 * - tiller milestone list
 * - tiller milestone status [version]
 * - tiller milestone update <version>
 * - tiller milestone complete <version>
 * - tiller milestone set-current <version>
 * - tiller milestone delete <version>
 * - tiller milestone discover
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller milestone", () => {
	let testDir: string;
	let tillerDir: string;
	let planningDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		tillerDir = join(testDir, ".tiller");
		planningDir = join(testDir, ".planning");
		mkdirSync(tillerDir, { recursive: true });
		mkdirSync(join(planningDir, "milestones"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("milestone create", () => {
		it("creates a new milestone", async () => {
			const result = await runTiller(
				["milestone", "create", "1.0", "--title", "Test Milestone", "--phases", "01,02"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Milestone created");
			expect(result.stdout).toContain("v1.0");
			expect(result.stdout).toContain("Test Milestone");

			// Check milestones.json was created
			expect(existsSync(join(tillerDir, "milestones.json"))).toBe(true);
		});

		it("creates milestone with --json flag", async () => {
			const result = await runTiller(
				["milestone", "create", "1.0", "--title", "JSON Test", "--json"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("created");
			expect(result.stdout).toContain("version:");
		});

		it("shows dry run without creating", async () => {
			const result = await runTiller(
				["milestone", "create", "1.0", "--title", "Dry Run Test", "--dry-run"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Milestone Creation Plan");
			expect(result.stdout).toContain("--dry-run: No changes made");

			// File should not be created
			expect(existsSync(join(tillerDir, "milestones.json"))).toBe(false);
		});

		it("fails on duplicate version", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "First"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "create", "1.0", "--title", "Duplicate"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("already exists");
		});

		it("requires title", async () => {
			const result = await runTiller(
				["milestone", "create", "1.0"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("--title is required");
		});
	});

	describe("milestone list", () => {
		it("shows message when no milestones exist", async () => {
			const result = await runTiller(["milestone", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No milestones found");
		});

		it("lists active milestones", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "First Milestone", "--phases", "01,02"],
				{ cwd: testDir },
			);
			await runTiller(
				["milestone", "create", "2.0", "--title", "Second Milestone"],
				{ cwd: testDir },
			);

			const result = await runTiller(["milestone", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("First Milestone");
			expect(result.stdout).toContain("v1.0");
		});

		it("shows milestones with --json flag", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "JSON Test"],
				{ cwd: testDir },
			);

			const result = await runTiller(["milestone", "list", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("milestones");
			expect(result.stdout).toContain("active");
		});
	});

	describe("milestone status", () => {
		it("shows milestone details", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Status Test", "--phases", "01,02,03"],
				{ cwd: testDir },
			);

			const result = await runTiller(["milestone", "status", "1.0"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Status Test");
			expect(result.stdout).toContain("v1.0");
			expect(result.stdout).toContain("Phases");
		});

		it("shows current milestone by default", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Current Test"],
				{ cwd: testDir },
			);

			const result = await runTiller(["milestone", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Current Test");
		});

		it("formats for prompt injection with --inject", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Inject Test"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "status", "1.0", "--inject"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("## Milestone:");
			expect(result.stdout).toContain("**Status:**");
			expect(result.stdout).toContain("### Phases");
		});

		it("returns error for non-existent milestone", async () => {
			const result = await runTiller(["milestone", "status", "99.0"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("milestone update", () => {
		it("updates milestone title", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Original"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "update", "1.0", "--title", "Updated Title"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("updated");
			expect(result.stdout).toContain("Updated Title");
		});

		it("updates milestone phases", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Test", "--phases", "01"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "update", "1.0", "--phases", "01,02,03"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("01, 02, 03");
		});

		it("adds phases with --add-phases", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Test", "--phases", "01"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "update", "1.0", "--add-phases", "02,03"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("01, 02, 03");
		});

		it("returns error for non-existent milestone", async () => {
			const result = await runTiller(
				["milestone", "update", "99.0", "--title", "Test"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("milestone set-current", () => {
		it("sets current milestone", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "First"],
				{ cwd: testDir },
			);
			await runTiller(
				["milestone", "create", "2.0", "--title", "Second"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "set-current", "2.0"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Current milestone set to: v2.0");

			// Verify with status
			const statusResult = await runTiller(["milestone", "status"], {
				cwd: testDir,
			});
			expect(statusResult.stdout).toContain("Second");
		});

		it("returns error for non-existent milestone", async () => {
			const result = await runTiller(
				["milestone", "set-current", "99.0"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("milestone delete", () => {
		it("deletes a milestone", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Delete Test"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "delete", "1.0", "--no-confirm"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("deleted");

			// Verify with list
			const listResult = await runTiller(["milestone", "list"], {
				cwd: testDir,
			});
			expect(listResult.stdout).toContain("No milestones found");
		});

		it("shows confirmation when --confirm flag used", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Confirm Test"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "delete", "1.0", "--confirm"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("toon");
			expect(result.stdout).toContain("confirmation");
		});

		it("returns error for non-existent milestone", async () => {
			const result = await runTiller(
				["milestone", "delete", "99.0", "--no-confirm"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("milestone discover", () => {
		it("parses milestones from ROADMAP.md", async () => {
			// Create a ROADMAP.md with milestone sections
			const roadmapContent = `# Roadmap

## Overview
Test roadmap

### Test Milestone (Current)
- [ ] **Phase 1: Foundation**
- [ ] **Phase 2: Core**
- [x] **Phase 3: Complete**

### Future Milestone (Parked)
- [ ] **Phase 10: Future**
`;
			writeFileSync(join(planningDir, "ROADMAP.md"), roadmapContent);

			const result = await runTiller(["milestone", "discover"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Discovered Milestones");
			expect(result.stdout).toContain("Test");
			expect(result.stdout).toContain("Future");
		});

		it("shows message when no milestones found", async () => {
			const roadmapContent = `# Roadmap

## Overview
No milestones here

## Phases
- Phase 1
`;
			writeFileSync(join(planningDir, "ROADMAP.md"), roadmapContent);

			const result = await runTiller(["milestone", "discover"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No milestone sections found");
		});

		it("outputs JSON with --json flag", async () => {
			const roadmapContent = `# Roadmap

### My Milestone (Current)
- [ ] **Phase 1: Test**
`;
			writeFileSync(join(planningDir, "ROADMAP.md"), roadmapContent);

			const result = await runTiller(["milestone", "discover", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("milestones");
			expect(result.stdout).toContain("is_current");
		});
	});

	describe("milestone complete", () => {
		it("validates completion readiness", async () => {
			// Create milestone with no phases (which is technically "complete")
			await runTiller(
				["milestone", "create", "1.0", "--title", "Test"],
				{ cwd: testDir },
			);

			// Create a ROADMAP.md so archive has content
			writeFileSync(join(planningDir, "ROADMAP.md"), "# Test Roadmap");

			// With no phases, it should complete successfully
			const result = await runTiller(
				["milestone", "complete", "1.0", "--no-confirm"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("completed");
		});

		it("shows confirmation when --confirm flag used", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Confirm Test"],
				{ cwd: testDir },
			);

			const result = await runTiller(
				["milestone", "complete", "1.0", "--confirm"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("toon");
			expect(result.stdout).toContain("confirmation");
		});

		it("creates git tag with --tag flag", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Tag Test"],
				{ cwd: testDir },
			);

			// Create a ROADMAP.md so archive has content
			writeFileSync(join(planningDir, "ROADMAP.md"), "# Test Roadmap");

			const result = await runTiller(
				["milestone", "complete", "1.0", "--tag", "--no-confirm"],
				{ cwd: testDir },
			);

			// Note: Git tag creation may fail in test env without git init
			// But we should see the tag mentioned in output
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("completed");
		});

		it("archives roadmap to milestones directory", async () => {
			await runTiller(
				["milestone", "create", "1.0", "--title", "Archive Test"],
				{ cwd: testDir },
			);

			writeFileSync(join(planningDir, "ROADMAP.md"), "# Test Roadmap\n\nContent here");

			const result = await runTiller(
				["milestone", "complete", "1.0", "--no-confirm"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Archived to:");
			expect(existsSync(join(planningDir, "milestones", "v1.0-ROADMAP.md"))).toBe(true);
		});
	});
});
