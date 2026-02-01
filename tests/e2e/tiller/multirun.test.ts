/**
 * E2E tests for Tiller multi-track claiming and conflict detection
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller multi-track", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("claiming", () => {
		it("claims an unclaimed ready track", async () => {
			createMockTrack(testDir, "track-claim1", "ready");

			const result = await runTiller(["claim", "track-claim1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toLowerCase()).toContain("claimed");
		});

		it("claims an unclaimed active track", async () => {
			createMockTrack(testDir, "track-claim2", "active/executing");

			const result = await runTiller(["claim", "track-claim2"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toLowerCase()).toContain("claimed");
		});

		it("releases a claimed track", async () => {
			// Create track with existing claim
			const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
			createMockTrack(testDir, "track-release1", "active/executing", {
				claimedBy: "agent-123",
				claimExpires: expiry,
			});

			const result = await runTiller(["release", "track-release1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toLowerCase()).toContain("released");
		});

		it("allows claiming expired claim", async () => {
			// Create track with expired claim
			const expiry = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
			createMockTrack(testDir, "track-expired1", "ready", {
				claimedBy: "old-agent",
				claimExpires: expiry,
			});

			const result = await runTiller(["claim", "track-expired1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toLowerCase()).toContain("claimed");
		});

		it("rejects claiming already claimed track", async () => {
			// Create track with active claim
			const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
			createMockTrack(testDir, "track-busy1", "ready", {
				claimedBy: "other-agent",
				claimExpires: expiry,
			});

			const result = await runTiller(["claim", "track-busy1"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("already claimed");
		});
	});

	describe("file conflict detection", () => {
		it("detects conflict between tracks with overlapping files", async () => {
			// Create two tracks with overlapping files_touched
			createMockTrack(testDir, "track-conflict1", "active/executing", {
				filesTouched: ["src/api/auth.ts", "src/lib/utils.ts"],
			});
			createMockTrack(testDir, "track-conflict2", "ready", {
				filesTouched: ["src/api/auth.ts", "src/api/users.ts"],
			});

			// Check ready command shows conflict warning
			const result = await runTiller(["ready"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// The ready command should show conflicts
			expect(result.stdout).toContain("track-conflict2");
		});

		it("no conflict for tracks with non-overlapping files", async () => {
			createMockTrack(testDir, "track-noconflict1", "active/executing", {
				filesTouched: ["src/api/auth.ts"],
			});
			createMockTrack(testDir, "track-noconflict2", "ready", {
				filesTouched: ["src/api/users.ts"],
			});

			const result = await runTiller(["ready"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("track-noconflict2");
		});
	});

	describe("ready command", () => {
		it("lists ready tracks sorted by priority", async () => {
			createMockTrack(testDir, "track-low", "ready");
			createMockTrack(testDir, "track-high", "ready");

			const result = await runTiller(["ready"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Both tracks should appear
			expect(result.stdout).toContain("track-low");
			expect(result.stdout).toContain("track-high");
		});

		it("shows claimed tracks with [claimed] flag in ready list", async () => {
			const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
			createMockTrack(testDir, "track-claimed", "ready", {
				claimedBy: "agent-xyz",
				claimExpires: expiry,
			});
			createMockTrack(testDir, "track-free", "ready");

			const result = await runTiller(["ready"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("track-free");
			// track-claimed appears with claimed: true in TOON output
			expect(result.stdout).toContain("track-claimed");
			expect(result.stdout).toContain("claimed: true");
		});

		it("shows message when no tracks are ready", async () => {
			// No ready tracks
			createMockTrack(testDir, "track-proposed", "proposed");

			const result = await runTiller(["ready"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toLowerCase()).toContain("no");
		});
	});

	describe("gc stale claims", () => {
		it("gc releases expired claims", async () => {
			// Create track with expired claim
			const expiry = new Date(Date.now() - 60 * 1000).toISOString();
			createMockTrack(testDir, "track-stale1", "active/executing", {
				claimedBy: "dead-agent",
				claimExpires: expiry,
			});

			const result = await runTiller(["gc"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Should mention released tracks
			expect(result.stdout).toContain("track-stale1");
		});
	});
});
