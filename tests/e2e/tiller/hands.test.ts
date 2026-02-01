/**
 * E2E tests for Tiller hands, agent, and gc commands
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller hand commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create a track for hand operations
		createMockTrack(testDir, "run-hand-test", "active/executing");
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("hand reserve", () => {
		it("reserves a hand slot with --run option", async () => {
			const result = await runTiller(
				["hand", "reserve", "--run", "run-hand-test"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Reserved hand");
			expect(result.stdout).toContain("run-hand-test");
		});

		it("reserves a hand slot using default track", async () => {
			const result = await runTiller(["hand", "reserve"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Reserved hand");
		});

		it("fails when no tracks exist", async () => {
			// Create empty test env with no tracks
			const emptyDir = await createTestEnv();
			// Remove the tracks directory contents (createTestEnv creates .tiller/tracks but no tracks)

			const result = await runTiller(["hand", "reserve"], { cwd: emptyDir });

			expect(result.exitCode).not.toBe(0);
			// Error may be in stdout or stderr
			expect(result.stdout + result.stderr).toContain("No run available");

			await cleanupTestEnv(emptyDir);
		});
	});

	describe("hand list", () => {
		it("shows no hands when none reserved", async () => {
			const result = await runTiller(["hand", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No hands reserved");
		});

		it("shows reserved hands in table format", async () => {
			// Reserve a hand first
			await runTiller(["hand", "reserve", "--run", "run-hand-test"], {
				cwd: testDir,
			});

			const result = await runTiller(["hand", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("NAME");
			expect(result.stdout).toContain("STATE");
			expect(result.stdout).toContain("RUN");
			expect(result.stdout).toContain("run-hand-test");
		});
	});

	describe("hand status", () => {
		it("shows detailed status of a hand", async () => {
			// Reserve a hand first
			const reserveResult = await runTiller(
				["hand", "reserve", "--run", "run-hand-test"],
				{ cwd: testDir },
			);
			// Extract the hand name from output
			const match = reserveResult.stdout.match(/Reserved hand: (\S+)/);
			expect(match).not.toBeNull();
			const handName = match?.[1];

			const result = await runTiller(["hand", "status", handName], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`Hand: ${handName}`);
			expect(result.stdout).toContain("State:");
			expect(result.stdout).toContain("Run: run-hand-test");
		});

		it("returns error for non-existent hand", async () => {
			const result = await runTiller(["hand", "status", "nonexistent-hand"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Hand not found");
		});
	});

	describe("hand kill", () => {
		it("kills (removes) a reserved hand", async () => {
			// Reserve a hand first
			const reserveResult = await runTiller(
				["hand", "reserve", "--run", "run-hand-test"],
				{ cwd: testDir },
			);
			const match = reserveResult.stdout.match(/Reserved hand: (\S+)/);
			expect(match).not.toBeNull();
			const handName = match?.[1];

			const result = await runTiller(["hand", "kill", handName], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Killed hand");

			// Verify hand is gone
			const statusResult = await runTiller(["hand", "status", handName], {
				cwd: testDir,
			});
			expect(statusResult.exitCode).not.toBe(0);
		});

		it("returns error for non-existent hand", async () => {
			const result = await runTiller(["hand", "kill", "nonexistent-hand"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Hand not found");
		});
	});
});

// Note: 'tiller run command' tests removed - feature was never implemented
// and hand system is deprecated in favor of 'mate' system

describe("tiller agent commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create agents directory
		mkdirSync(join(testDir, ".tiller", "agents"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("agent register", () => {
		it("registers an agent", async () => {
			const result = await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-1" },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Agent registered");
			expect(result.stdout).toContain("test-agent-1");
		});

		it("fails without TILLER_AGENT env var", async () => {
			const result = await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: undefined },
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("TILLER_AGENT");
		});

		it("fails when agent already registered and active", async () => {
			// Register first time
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-2" },
			});

			// Try to register again
			const result = await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-2" },
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("already registered");
		});
	});

	describe("agent report", () => {
		it("reports agent state", async () => {
			// Register first
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-3" },
			});

			// Report working state
			const result = await runTiller(
				["agent", "report", "working", "Processing task"],
				{
					cwd: testDir,
					env: { ...process.env, TILLER_AGENT: "test-agent-3" },
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("working");
			expect(result.stdout).toContain("Processing task");
		});

		it("rejects invalid state", async () => {
			// Register first
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-4" },
			});

			const result = await runTiller(["agent", "report", "invalid-state"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-4" },
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Invalid state");
		});

		it("fails when agent not registered", async () => {
			const result = await runTiller(["agent", "report", "working"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "unregistered-agent" },
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("not registered");
		});
	});

	describe("agent heartbeat", () => {
		it("sends heartbeat for registered agent", async () => {
			// Register first
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-5" },
			});

			const result = await runTiller(["agent", "heartbeat"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-5" },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Heartbeat");
			expect(result.stdout).toContain("test-agent-5");
		});

		it("fails when agent not registered", async () => {
			const result = await runTiller(["agent", "heartbeat"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "unregistered-agent" },
			});

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("not registered");
		});
	});

	describe("agent unregister", () => {
		it("unregisters an agent", async () => {
			// Register first
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-6" },
			});

			const result = await runTiller(["agent", "unregister"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "test-agent-6" },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("unregistered");
		});

		it("handles unregistering non-existent agent gracefully", async () => {
			const result = await runTiller(["agent", "unregister"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "nonexistent-agent" },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("not registered");
		});
	});

	describe("agents list", () => {
		it("shows no agents when none registered", async () => {
			const result = await runTiller(["agents"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No agents registered");
		});

		it("lists registered agents", async () => {
			// Register two agents
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "agent-a" },
			});
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "agent-b" },
			});

			const result = await runTiller(["agents"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("AGENTS");
			expect(result.stdout).toContain("agent-a");
			expect(result.stdout).toContain("agent-b");
		});

		it("outputs JSON with --json flag", async () => {
			// Register an agent
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "json-agent" },
			});

			const result = await runTiller(["agents", "--json"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout);
			expect(Array.isArray(parsed)).toBe(true);
			expect(parsed.length).toBe(1);
			expect(parsed[0].agent).toBe("json-agent");
		});
	});
});

describe("tiller gc command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("reports no stale claims when none exist", async () => {
		// Create a track without any claims
		createMockTrack(testDir, "track-gc-test", "active/executing");

		const result = await runTiller(["gc"], { cwd: testDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No stale claims found");
	});

	it("releases expired claims", async () => {
		// Create a track with an expired claim
		const expiredTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
		createMockTrack(testDir, "track-expired", "active/executing", {
			claimedBy: "dead-agent",
			claimExpires: expiredTime,
		});

		const result = await runTiller(["gc"], { cwd: testDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stale claim");
		expect(result.stdout).toContain("track-expired");
		expect(result.stdout).toContain("Cleaned");
	});

	it("shows what would be released with --dry-run", async () => {
		// Create a track with an expired claim
		const expiredTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		createMockTrack(testDir, "track-dry-run", "active/executing", {
			claimedBy: "dead-agent",
			claimExpires: expiredTime,
		});

		const result = await runTiller(["gc", "--dry-run"], { cwd: testDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("stale claim");
		expect(result.stdout).toContain("track-dry-run");
		expect(result.stdout).toContain("dry run");
		// Should not have "Cleaned" message
		expect(result.stdout).not.toContain("Cleaned");
	});

	it("does not release non-expired claims", async () => {
		// Create a track with a future claim expiry
		const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
		createMockTrack(testDir, "track-fresh", "active/executing", {
			claimedBy: "active-agent",
			claimExpires: futureTime,
		});

		const result = await runTiller(["gc"], { cwd: testDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No stale claims found");
	});
});
