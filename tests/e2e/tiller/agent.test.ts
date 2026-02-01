/**
 * E2E tests for Tiller agent observability commands
 *
 * Commands:
 * - agent register   - Register agent for observability
 * - agent report     - Report agent state (idle|working|stuck)
 * - agent heartbeat  - Send heartbeat to prove liveness
 * - agent unregister - Unregister agent (clean exit)
 * - agents           - List all registered agents
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller agent commands", () => {
	let testDir: string;
	const agentName = "test-agent-001";

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Set up TILLER_AGENT env var for consistent agent name
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("agent register", () => {
		it("registers a new agent", async () => {
			const result = await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Agent registered");
			expect(result.stdout).toContain(agentName);
			expect(result.stdout).toContain("idle");
		});

		it("fails if agent already registered", async () => {
			// Register once
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			// Try to register again
			const result = await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("already registered");
		});
	});

	describe("agent report", () => {
		it("reports idle state", async () => {
			// Register first
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(["agent", "report", "idle"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("idle");
		});

		it("reports working state with message", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(
				["agent", "report", "working", "Executing task 5"],
				{
					cwd: testDir,
					env: { ...process.env, TILLER_AGENT: agentName },
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("working");
			expect(result.stdout).toContain("Executing task 5");
		});

		it("reports stuck state", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(
				["agent", "report", "stuck", "Blocked on external dependency"],
				{
					cwd: testDir,
					env: { ...process.env, TILLER_AGENT: agentName },
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("stuck");
		});

		it("fails with invalid state", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(["agent", "report", "invalid-state"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Invalid state");
		});

		it("fails if agent not registered", async () => {
			const result = await runTiller(["agent", "report", "idle"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "unregistered-agent" },
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not registered");
		});
	});

	describe("agent heartbeat", () => {
		it("sends heartbeat for registered agent", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(["agent", "heartbeat"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Heartbeat");
			expect(result.stdout).toContain(agentName);
		});

		it("fails if agent not registered", async () => {
			const result = await runTiller(["agent", "heartbeat"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "unregistered-agent" },
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not registered");
		});
	});

	describe("agent unregister", () => {
		it("unregisters a registered agent", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(["agent", "unregister"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("unregistered");
		});

		it("succeeds silently if agent not registered", async () => {
			const result = await runTiller(["agent", "unregister"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "never-registered" },
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("not registered");
		});
	});

	describe("agents list", () => {
		it("lists no agents when none registered", async () => {
			const result = await runTiller(["agents"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No agents");
		});

		it("lists registered agents", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(["agents"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("AGENTS");
			expect(result.stdout).toContain(agentName);
			expect(result.stdout).toContain("idle");
		});

		it("outputs JSON with --json flag", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: agentName },
			});

			const result = await runTiller(["agents", "--json"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(Array.isArray(json)).toBe(true);
			expect(json.length).toBe(1);
			expect(json[0].agent).toBe(agentName);
			expect(json[0].state).toBe("idle");
		});

		it("shows multiple agents", async () => {
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "agent-alpha" },
			});
			await runTiller(["agent", "register"], {
				cwd: testDir,
				env: { ...process.env, TILLER_AGENT: "agent-beta" },
			});

			const result = await runTiller(["agents"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("agent-alpha");
			expect(result.stdout).toContain("agent-beta");
			expect(result.stdout).toContain("2 agent(s)");
		});
	});

	describe("agent lifecycle", () => {
		it("completes full lifecycle: register → report → heartbeat → unregister", async () => {
			const env = { ...process.env, TILLER_AGENT: agentName };

			// 1. Register
			let result = await runTiller(["agent", "register"], {
				cwd: testDir,
				env,
			});
			expect(result.exitCode).toBe(0);

			// 2. Report working
			result = await runTiller(
				["agent", "report", "working", "Starting task"],
				{
					cwd: testDir,
					env,
				},
			);
			expect(result.exitCode).toBe(0);

			// 3. Heartbeat
			result = await runTiller(["agent", "heartbeat"], { cwd: testDir, env });
			expect(result.exitCode).toBe(0);

			// 4. Report idle
			result = await runTiller(["agent", "report", "idle"], {
				cwd: testDir,
				env,
			});
			expect(result.exitCode).toBe(0);

			// 5. Unregister
			result = await runTiller(["agent", "unregister"], { cwd: testDir, env });
			expect(result.exitCode).toBe(0);

			// 6. Verify gone
			result = await runTiller(["agents", "--json"], { cwd: testDir });
			const agents = JSON.parse(result.stdout);
			expect(
				agents.find((a: { agent: string }) => a.agent === agentName),
			).toBeUndefined();
		});
	});
});
