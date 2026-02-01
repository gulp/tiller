/**
 * E2E tests for Tiller claiming commands - Multi-track agent coordination
 *
 * Commands:
 * - claim <track-id>   - Claim a track for exclusive work
 * - release <track-id> - Release claim on a track
 * - gc                 - Release expired track claims
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller claiming commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("claim command", () => {
		it("claims an available track", async () => {
			const planPath = ".planning/phases/test/run-claim01-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim01", "ready", { planPath });

			const result = await runTiller(["claim", "run-claim01"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Claimed run: run-claim01");
			expect(result.stdout).toContain("Agent:");
			expect(result.stdout).toContain("Expires:");

			// Verify track is now claimed
			const trackFile = join(testDir, ".tiller/runs/run-claim01.json");
			const track = JSON.parse(readFileSync(trackFile, "utf-8"));
			expect(track.claimed_by).toBeDefined();
			expect(track.claimed_at).toBeDefined();
			expect(track.claim_expires).toBeDefined();
		});

		it("fails for non-existent track", async () => {
			const result = await runTiller(["claim", "nonexistent"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("Run not found");
		});

		it("fails when track is already claimed", async () => {
			const planPath = ".planning/phases/test/run-claim02-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim02", "ready", {
				planPath,
				claimedBy: "other-agent",
				claimExpires: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
			});

			const result = await runTiller(["claim", "run-claim02"], { cwd: testDir });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("already claimed");
		});

		it("accepts custom TTL with --ttl option", async () => {
			const planPath = ".planning/phases/test/run-claim03-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim03", "ready", { planPath });

			const result = await runTiller(["claim", "run-claim03", "--ttl", "60"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Claimed run");
		});

		it("accepts custom agent ID with --agent option", async () => {
			const planPath = ".planning/phases/test/run-claim04-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim04", "ready", { planPath });

			const result = await runTiller(
				["claim", "run-claim04", "--agent", "custom-agent-123"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Agent: custom-agent-123");
		});

		it("detects file conflicts with active tracks", async () => {
			// Create two tracks with overlapping files
			const planPath1 = ".planning/phases/test/run-claim05-PLAN.md";
			const planPath2 = ".planning/phases/test/run-claim06-PLAN.md";
			createMockPlan(testDir, planPath1);
			createMockPlan(testDir, planPath2);

			createMockTrack(testDir, "run-claim05", "active/executing", {
				planPath: planPath1,
				filesTouched: ["src/shared.ts", "src/module.ts"],
			});
			createMockTrack(testDir, "run-claim06", "ready", {
				planPath: planPath2,
				filesTouched: ["src/shared.ts", "src/other.ts"],
			});

			const result = await runTiller(["claim", "run-claim06"], { cwd: testDir });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("conflict");
		});

		it("allows claim with conflicts when --force is used", async () => {
			const planPath1 = ".planning/phases/test/run-claim07-PLAN.md";
			const planPath2 = ".planning/phases/test/run-claim08-PLAN.md";
			createMockPlan(testDir, planPath1);
			createMockPlan(testDir, planPath2);

			createMockTrack(testDir, "run-claim07", "active/executing", {
				planPath: planPath1,
				filesTouched: ["src/conflict.ts"],
			});
			createMockTrack(testDir, "run-claim08", "ready", {
				planPath: planPath2,
				filesTouched: ["src/conflict.ts"],
			});

			const result = await runTiller(["claim", "run-claim08", "--force"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Claimed run");
			expect(result.stdout).toContain("Conflicts");
		});
	});

	describe("release command", () => {
		it("releases a claimed track", async () => {
			const planPath = ".planning/phases/test/run-claim09-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim09", "ready", {
				planPath,
				claimedBy: "test-agent",
				claimExpires: new Date(Date.now() + 3600000).toISOString(),
			});

			const result = await runTiller(["release", "run-claim09"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Released run: run-claim09");

			// Verify claim is cleared
			const trackFile = join(testDir, ".tiller/runs/run-claim09.json");
			const track = JSON.parse(readFileSync(trackFile, "utf-8"));
			expect(track.claimed_by).toBeNull();
		});

		it("reports when track is not claimed", async () => {
			const planPath = ".planning/phases/test/run-claim10-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim10", "ready", { planPath });

			const result = await runTiller(["release", "run-claim10"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("not claimed");
		});

		it("fails for non-existent track", async () => {
			const result = await runTiller(["release", "ghost-track"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("Run not found");
		});
	});

	describe("gc command", () => {
		it("reports no stale claims when none exist", async () => {
			const planPath = ".planning/phases/test/run-claim11-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim11", "ready", { planPath });

			const result = await runTiller(["gc"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No stale claims found");
		});

		it("finds and releases expired claims", async () => {
			const planPath = ".planning/phases/test/run-claim12-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim12", "ready", {
				planPath,
				claimedBy: "expired-agent",
				claimExpires: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
			});

			const result = await runTiller(["gc"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("stale claim");
			expect(result.stdout).toContain("run-claim12");
			expect(result.stdout).toContain("Cleaned");
		});

		it("shows what would be cleaned with --dry-run", async () => {
			const planPath = ".planning/phases/test/run-claim13-PLAN.md";
			createMockPlan(testDir, planPath);
			createMockTrack(testDir, "run-claim13", "ready", {
				planPath,
				claimedBy: "stale-agent",
				claimExpires: new Date(Date.now() - 1000).toISOString(),
			});

			const result = await runTiller(["gc", "--dry-run"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("stale claim");
			expect(result.stdout).toContain("dry run");

			// Verify claim is NOT cleared (dry run)
			const trackFile = join(testDir, ".tiller/runs/run-claim13.json");
			const track = JSON.parse(readFileSync(trackFile, "utf-8"));
			expect(track.claimed_by).toBe("stale-agent");
		});
	});
});
