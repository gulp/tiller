/**
 * E2E tests for Tiller roadmap and phase commands
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller roadmap commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("roadmap create", () => {
		it("creates ROADMAP.md with basic template", async () => {
			// Remove existing ROADMAP.md if present
			const roadmapPath = join(testDir, ".planning", "phases", "test", "ROADMAP.md");
			const { rmSync } = await import("node:fs");
			if (existsSync(roadmapPath)) {
				rmSync(roadmapPath);
			}

			const result = await runTiller(["roadmap", "create", "Test Project"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created");

			// Verify file was created
			expect(existsSync(roadmapPath)).toBe(true);
			const content = readFileSync(roadmapPath, "utf-8");
			expect(content).toContain("# Roadmap: Test Project");
			expect(content).toContain("## Overview");
			expect(content).toContain("## Progress");
		});

		it("creates ROADMAP.md with initial phase", async () => {
			const roadmapPath = join(testDir, ".planning", "phases", "test", "ROADMAP.md");
			const { rmSync } = await import("node:fs");
			if (existsSync(roadmapPath)) {
				rmSync(roadmapPath);
			}

			const result = await runTiller(
				["roadmap", "create", "Test Project", "--init-phase", "Foundation"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);

			// Verify ROADMAP.md content
			const content = readFileSync(roadmapPath, "utf-8");
			expect(content).toContain("Phase 1: Foundation");
			expect(content).toContain("01-01");

			// Verify phase directory was created
			const phaseDirPath = join(testDir, ".planning", "phases", "test", "01-foundation");
			expect(existsSync(phaseDirPath)).toBe(true);
		});

		it("fails when ROADMAP.md already exists", async () => {
			// Ensure ROADMAP.md exists
			const { mkdirSync } = await import("node:fs");
			const roadmapPath = join(testDir, ".planning", "phases", "test", "ROADMAP.md");
			const roadmapDir = join(testDir, ".planning", "phases", "test");
			if (!existsSync(roadmapDir)) {
				mkdirSync(roadmapDir, { recursive: true });
			}
			if (!existsSync(roadmapPath)) {
				writeFileSync(roadmapPath, "# Existing Roadmap\n");
			}

			const result = await runTiller(["roadmap", "create", "New Project"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("already exists");
		});

		it("--dry-run shows plan without creating files", async () => {
			const roadmapPath = join(testDir, ".planning", "phases", "test", "ROADMAP.md");
			const { rmSync } = await import("node:fs");
			if (existsSync(roadmapPath)) {
				rmSync(roadmapPath);
			}

			const result = await runTiller(
				["roadmap", "create", "Test Project", "--dry-run"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("dry-run");
			expect(result.stdout).toContain("Roadmap Creation Plan");
			// File should NOT be created
			expect(existsSync(roadmapPath)).toBe(false);
		});

		it("--json outputs structured JSON", async () => {
			const roadmapPath = join(testDir, ".planning", "phases", "test", "ROADMAP.md");
			const { rmSync } = await import("node:fs");
			if (existsSync(roadmapPath)) {
				rmSync(roadmapPath);
			}

			const result = await runTiller(
				["roadmap", "create", "Test Project", "--json"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json.action).toBe("create");
			expect(json.title).toBe("Test Project");
			expect(json.success).toBe(true);
		});
	});

	describe("roadmap sync", () => {
		it("fails when no ROADMAP.md found", async () => {
			const result = await runTiller(["roadmap", "sync"], { cwd: testDir });

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("ROADMAP.md not found");
		});

		it("syncs phase sections in ROADMAP.md", async () => {
			// Create ROADMAP.md with sync fences
			const roadmapContent = `# Project Roadmap

## Overview

Project overview text.

## Phases

### Phase 01: Initial Setup

<!-- SYNCED: tiller roadmap sync -->
**Plans**: 0 plans
<!-- END SYNCED -->

Description of phase 01.

### Phase 02: Development

<!-- SYNCED: tiller roadmap sync -->
**Plans**: 0 plans
<!-- END SYNCED -->

Description of phase 02.
`;
			const planningDir = join(testDir, ".planning");
			writeFileSync(join(planningDir, "ROADMAP.md"), roadmapContent);

			// Create some tracks for phase 01
			const planPath = ".planning/phases/01/01-01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "track-01-01", "complete", {
				planPath,
				intent: "Initial setup task",
			});

			const result = await runTiller(["roadmap", "sync"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Output may say "Synced", "No changes", or show sync results
			expect(result.stdout).toMatch(/Synced|No changes|Phase 01/);
		});

		it("reports when no sync fences found", async () => {
			// Create ROADMAP.md without sync fences
			const roadmapContent = `# Project Roadmap

## Phases

### Phase 01: Setup

Just plain markdown, no sync fences.
`;
			const planningDir = join(testDir, ".planning");
			writeFileSync(join(planningDir, "ROADMAP.md"), roadmapContent);

			const result = await runTiller(["roadmap", "sync"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Should indicate no fences or no changes
			expect(result.stdout).toMatch(/no-fence|No changes|fence/);
		});

		it("--dry-run shows what would be synced without writing", async () => {
			const roadmapContent = `# Project Roadmap

### Phase 01: Test

<!-- SYNCED: tiller roadmap sync -->
Old content
<!-- END SYNCED -->
`;
			const planningDir = join(testDir, ".planning");
			writeFileSync(join(planningDir, "ROADMAP.md"), roadmapContent);

			const result = await runTiller(["roadmap", "sync", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("dry-run");
		});
	});
});

describe("tiller phase commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("phase status", () => {
		it("shows no phases when no tracks exist", async () => {
			const result = await runTiller(["phase", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Should report no phases or empty result
			expect(result.stdout).toMatch(/No phases|No tracks|^\[?\]?$/m);
		});

		it("shows phase status from tracks", async () => {
			// Create tracks for multiple phases
			const plan1Path = ".planning/phases/01-setup/01-01-PLAN.md";
			createMockPlan(testDir, plan1Path);
			createMockTrack(testDir, "track-phase1", "complete", {
				planPath: plan1Path,
			});

			const plan2Path = ".planning/phases/02-dev/02-01-PLAN.md";
			createMockPlan(testDir, plan2Path);
			createMockTrack(testDir, "track-phase2", "active/executing", {
				planPath: plan2Path,
			});

			const result = await runTiller(["phase", "status"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Should display phase information
		});

		it("outputs JSON with --json flag", async () => {
			const planPath = ".planning/phases/04-json/04-01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "track-json", "proposed", { planPath });

			const result = await runTiller(["phase", "status", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(Array.isArray(json)).toBe(true);
		});
	});
});
