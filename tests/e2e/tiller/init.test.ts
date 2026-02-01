/**
 * E2E tests for Tiller init, import, and rework commands
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller init command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("init with single PLAN.md", () => {
		it("creates track from single PLAN.md file", async () => {
			const planPath = ".planning/phases/test/01-01-PLAN.md";
			const planContent = `---
phase: test
plan: 01
type: execute
---

<objective>
Implement test feature for init command.
</objective>

Test plan content.
`;
			createMockPlan(testDir, planPath, planContent);

			const result = await runTiller(["init", planPath, "--no-beads"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created 1 run");
			// Runs are created in ready state (no longer proposed)
			expect(result.stdout).toContain("ready");
		});

		it("extracts objective from PLAN.md for track intent", async () => {
			const planPath = ".planning/phases/test/01-02-PLAN.md";
			const planContent = `---
phase: test
plan: 02
type: execute
---

<objective>
Extract this specific objective text for the track.
</objective>

Additional plan content.
`;
			createMockPlan(testDir, planPath, planContent);

			const result = await runTiller(["init", planPath, "--no-beads"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// The track should be created
			expect(result.stdout).toContain("Created 1 run");
		});
	});

	describe("init with phase directory", () => {
		it("creates tracks from all PLANs in directory", async () => {
			const phaseDir = ".planning/phases/02-multi";
			mkdirSync(join(testDir, phaseDir), { recursive: true });

			// Create multiple PLAN.md files
			createMockPlan(
				testDir,
				`${phaseDir}/02-01-PLAN.md`,
				`---
phase: 02-multi
plan: 01
type: execute
---
<objective>First plan objective</objective>
`,
			);
			createMockPlan(
				testDir,
				`${phaseDir}/02-02-PLAN.md`,
				`---
phase: 02-multi
plan: 02
type: execute
---
<objective>Second plan objective</objective>
`,
			);
			createMockPlan(
				testDir,
				`${phaseDir}/02-03-PLAN.md`,
				`---
phase: 02-multi
plan: 03
type: execute
---
<objective>Third plan objective</objective>
`,
			);

			const result = await runTiller(["init", phaseDir, "--no-beads"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created 3 run");
		});

		it("skips existing tracks", async () => {
			const phaseDir = ".planning/phases/03-partial";
			mkdirSync(join(testDir, phaseDir), { recursive: true });

			// Create a plan and manually create its track
			const planPath = `${phaseDir}/03-01-PLAN.md`;
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "existing-track", "proposed", { planPath });

			// Create another plan without a track
			createMockPlan(testDir, `${phaseDir}/03-02-PLAN.md`);

			const result = await runTiller(["init", phaseDir, "--no-beads"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Skipping 1 existing");
			expect(result.stdout).toContain("Created 1 run");
		});
	});

	describe("init --no-beads", () => {
		it("creates track without beads integration", async () => {
			const planPath = ".planning/phases/test/04-01-PLAN.md";
			createMockPlan(testDir, planPath);

			const result = await runTiller(["init", planPath, "--no-beads"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("no beads");
		});
	});

	describe("init --dry-run", () => {
		it("shows what would be created without creating", async () => {
			const planPath = ".planning/phases/test/05-01-PLAN.md";
			createMockPlan(testDir, planPath);

			const result = await runTiller(["init", planPath, "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Would create");
			expect(result.stdout).toContain(planPath);

			// Verify no track was created
			const listResult = await runTiller(["list", "--json"], { cwd: testDir });
			const tracks = JSON.parse(listResult.stdout);
			expect(tracks.length).toBe(0);
		});
	});

	describe("init error handling", () => {
		it("fails for non-existent file path", async () => {
			const result = await runTiller(
				["init", "nonexistent/path/PLAN.md", "--no-beads"],
				{ cwd: testDir },
			);

			expect(result.exitCode).not.toBe(0);
			// The init command shows helpful error for non-existent path
			// Error may be in stdout or stderr depending on how tiller outputs errors
			expect(result.stdout + result.stderr).toContain("not found");
		});

		it("fails for directory with no PLAN.md files", async () => {
			const emptyDir = ".planning/phases/empty";
			mkdirSync(join(testDir, emptyDir), { recursive: true });

			const result = await runTiller(["init", emptyDir, "--no-beads"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("No PLAN.md files found");
		});

		it("reports when all plans already have tracks", async () => {
			const planPath = ".planning/phases/test/06-01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "already-exists", "proposed", { planPath });

			const result = await runTiller(["init", planPath, "--no-beads"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("All plans already have runs");
		});
	});
});

describe("tiller import command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("transitions approved → ready", async () => {
		createMockTrack(testDir, "track-import1", "approved");

		const result = await runTiller(["import", "track-import1"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("ready");
	});

	it("fails on non-approved track", async () => {
		createMockTrack(testDir, "track-import2", "proposed");

		const result = await runTiller(["import", "track-import2"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Cannot import");
	});

	it("fails on already-ready track", async () => {
		createMockTrack(testDir, "track-import3", "ready");

		const result = await runTiller(["import", "track-import3"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Cannot import");
	});

	it("fails for non-existent track", async () => {
		const result = await runTiller(["import", "nonexistent-track"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not found");
	});
});

describe("tiller rework command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("transitions verifying/testing → active/executing", async () => {
		createMockTrack(testDir, "track-rework1", "verifying/testing");

		const result = await runTiller(["rework", "track-rework1"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("active/executing");
		expect(result.stdout).toContain("rework");
	});

	it("transitions verifying/failed → active/executing", async () => {
		createMockTrack(testDir, "track-rework2", "verifying/failed");

		const result = await runTiller(["rework", "track-rework2"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("active/executing");
	});

	it("transitions verifying/passed → active/executing", async () => {
		createMockTrack(testDir, "track-rework3", "verifying/passed");

		const result = await runTiller(["rework", "track-rework3"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("active/executing");
	});

	it("fails on non-verifying track", async () => {
		createMockTrack(testDir, "track-rework4", "active/executing");

		const result = await runTiller(["rework", "track-rework4"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Cannot rework");
	});

	it("fails on proposed track", async () => {
		createMockTrack(testDir, "track-rework5", "proposed");

		const result = await runTiller(["rework", "track-rework5"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not in verifying");
	});

	it("fails for non-existent track", async () => {
		const result = await runTiller(["rework", "ghost-track"], { cwd: testDir });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not found");
	});
});
