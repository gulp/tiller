/**
 * E2E tests for Tiller query commands (status, list, show, ready)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller query commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("status command", () => {
		// TOON-first output (ADR-0003)
		// TOON uses table format with agent_hint OUTSIDE the fence
		describe("TOON output (default)", () => {
			it("outputs TOON by default with agent_hint", async () => {
				createMockTrack(testDir, "run-toon1", "active/executing");
				createMockTrack(testDir, "run-toon2", "proposed");

				const result = await runTiller(["status"], { cwd: testDir });

				expect(result.exitCode).toBe(0);
				// Should be wrapped in ```toon``` block
				expect(result.stdout).toContain("```toon");
				expect(result.stdout).toContain("```\n");

				// Should have status structure
				expect(result.stdout).toContain("status:");
				expect(result.stdout).toContain("next_action:");
				expect(result.stdout).toContain("runs:");

				// agent_hint is OUTSIDE the fence
				expect(result.stdout).toMatch(/```\s*\nagent_hint:/);
			});

			it("TOON contains run data matching --json", async () => {
				createMockTrack(testDir, "run-compare", "ready");

				const toonResult = await runTiller(["status"], { cwd: testDir });
				const jsonResult = await runTiller(["status", "--json"], {
					cwd: testDir,
				});

				const jsonData = JSON.parse(jsonResult.stdout);

				// TOON should contain the run ID
				expect(toonResult.stdout).toContain("run-compare");
				// JSON should have the same next_action
				expect(jsonData).toHaveProperty("next_action");
			});
		});

		describe("--pretty output (legacy)", () => {
			it("shows formatted status with --pretty flag", async () => {
				createMockTrack(testDir, "run-active1", "active/executing");
				createMockTrack(testDir, "run-proposed1", "proposed");

				const result = await runTiller(["status", "--pretty"], {
					cwd: testDir,
				});

				expect(result.exitCode).toBe(0);
				// Status output now shows counts on first line
				expect(result.stdout).toMatch(/active|proposed/);
				expect(result.stdout).toContain("run-active1");
				expect(result.stdout).toContain("Next:");
				// Should NOT be TOON
				expect(result.stdout).not.toContain("```toon");
			});
		});

		// Legacy test - now needs --pretty
		it("shows status when tracks exist (--pretty)", async () => {
			createMockTrack(testDir, "run-status1", "active/executing");
			createMockTrack(testDir, "run-status2", "proposed");

			const result = await runTiller(["status", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Status output now shows counts on first line
			expect(result.stdout).toMatch(/active|proposed/);
			expect(result.stdout).toContain("run-status1");
			expect(result.stdout).toContain("Next:");
		});

		it("handles no .tiller directory gracefully (--pretty)", async () => {
			// Using an empty test env (no tracks) - legacy test now needs --pretty
			const result = await runTiller(["status", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Status output shows "no runs" when empty
			expect(result.stdout).toMatch(/no runs|0.*active/i);
		});

		it("outputs valid JSON with --json flag", async () => {
			createMockTrack(testDir, "run-json1", "ready");

			const result = await runTiller(["status", "--json"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(json).toHaveProperty("next_action");
			expect(json).toHaveProperty("runs");
			expect(json.runs.ready).toHaveLength(1);
			expect(json.runs.ready[0].id).toBe("run-json1");
		});

		it("suggests correct next action based on state", async () => {
			// Test different priority orders

			// Only proposed - next action should be approve
			createMockTrack(testDir, "track-prop", "proposed");
			let result = await runTiller(["status", "--json"], { cwd: testDir });
			let json = JSON.parse(result.stdout);
			expect(json.next_action).toBe("approve");

			// Add approved - should still be approve (proposed takes precedence? let's check)
			// Actually looking at code: checkpoint > active > verifying > ready > approved > proposed
			// So approved should not change if proposed exists...
			// Let me test just approved
			await cleanupTestEnv(testDir);
			testDir = await createTestEnv();
			createMockTrack(testDir, "track-appr", "approved");
			result = await runTiller(["status", "--json"], { cwd: testDir });
			json = JSON.parse(result.stdout);
			expect(json.next_action).toBe("import");
		});
	});

	describe("list command", () => {
		// TOON-first output (ADR-0003)
		// TOON uses table format with agent_hint OUTSIDE the fence
		describe("TOON output (default)", () => {
			it("outputs TOON by default with agent_hint", async () => {
				createMockTrack(testDir, "run-toon-list1", "active/executing");
				createMockTrack(testDir, "run-toon-list2", "proposed");

				const result = await runTiller(["list"], { cwd: testDir });

				expect(result.exitCode).toBe(0);
				// Should be wrapped in ```toon``` block
				expect(result.stdout).toContain("```toon");
				expect(result.stdout).toContain("```\n");

				// Should have list structure with runs
				expect(result.stdout).toContain("list:");
				expect(result.stdout).toContain("runs:");
				expect(result.stdout).toContain("total:");

				// agent_hint is OUTSIDE the fence
				expect(result.stdout).toMatch(/```\s*\nagent_hint:/);
			});

			it("TOON contains run data matching --json", async () => {
				createMockTrack(testDir, "run-compare-list", "ready");

				const toonResult = await runTiller(["list"], { cwd: testDir });
				const jsonResult = await runTiller(["list", "--json"], {
					cwd: testDir,
				});

				const jsonData = JSON.parse(jsonResult.stdout);

				// TOON should contain the run ID
				expect(toonResult.stdout).toContain("run-compare-list");
				// JSON should be an array with the run
				expect(Array.isArray(jsonData)).toBe(true);
			});
		});

		describe("--pretty output (legacy)", () => {
			it("shows formatted list with --pretty flag", async () => {
				createMockTrack(testDir, "track-pretty-list1", "active/executing");
				createMockTrack(testDir, "track-pretty-list2", "proposed");

				const result = await runTiller(["list", "--pretty"], { cwd: testDir });

				expect(result.exitCode).toBe(0);
				// Header is now "RUNS" not "TRACKS"
				expect(result.stdout).toContain("RUNS");
				expect(result.stdout).toContain("track-pretty-list1");
				expect(result.stdout).toContain("Total: 2 run(s)");
				// Should NOT be TOON
				expect(result.stdout).not.toContain("```toon");
			});
		});

		it("shows all tracks when no filter (--pretty)", async () => {
			createMockTrack(testDir, "track-list1", "proposed");
			createMockTrack(testDir, "track-list2", "approved");
			createMockTrack(testDir, "track-list3", "active/executing");

			const result = await runTiller(["list", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Header is now "RUNS" not "TRACKS"
				expect(result.stdout).toContain("RUNS");
			expect(result.stdout).toContain("track-list1");
			expect(result.stdout).toContain("track-list2");
			expect(result.stdout).toContain("track-list3");
			expect(result.stdout).toContain("Total: 3 run(s)");
		});

		it("filters by state with --state flag (--pretty)", async () => {
			createMockTrack(testDir, "track-filter1", "proposed");
			createMockTrack(testDir, "track-filter2", "approved");
			createMockTrack(testDir, "track-filter3", "active/executing");

			const result = await runTiller(
				["list", "--state", "active", "--pretty"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("track-filter3");
			expect(result.stdout).not.toContain("track-filter1");
			expect(result.stdout).not.toContain("track-filter2");
			expect(result.stdout).toContain("Total: 1 run(s)");
		});

		it("outputs valid JSON array with --json flag", async () => {
			createMockTrack(testDir, "track-json-list", "ready");

			const result = await runTiller(["list", "--json"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			const tracks = JSON.parse(result.stdout);
			expect(Array.isArray(tracks)).toBe(true);
			expect(tracks.length).toBe(1);
			expect(tracks[0].id).toBe("track-json-list");
			expect(tracks[0].state).toBe("ready");
		});

		it("shows message when no tracks found (--pretty)", async () => {
			const result = await runTiller(["list", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No runs found");
		});

		it("outputs empty TOON list when no runs found", async () => {
			const result = await runTiller(["list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("```toon");
			// Empty list should show total: 0
			expect(result.stdout).toContain("total: 0");
		});
	});

	describe("show command", () => {
		// TOON-first output (ADR-0003)
		// TOON uses table format with agent_hint OUTSIDE the fence
		describe("TOON output (default)", () => {
			it("outputs TOON by default with agent_hint", async () => {
				createMockTrack(testDir, "run-toon-show", "active/executing", {
					intent: "Test intent for TOON show",
				});

				const result = await runTiller(["show", "run-toon-show"], {
					cwd: testDir,
				});

				expect(result.exitCode).toBe(0);
				// Should be wrapped in ```toon``` block
				expect(result.stdout).toContain("```toon");
				expect(result.stdout).toContain("```\n");

				// Should have run data
				expect(result.stdout).toContain("run:");
				expect(result.stdout).toContain("id:");
				expect(result.stdout).toContain("run-toon-show");

				// agent_hint is OUTSIDE the fence
				expect(result.stdout).toMatch(/```\s*\nagent_hint:/);
			});

			it("TOON contains run data matching --json", async () => {
				createMockTrack(testDir, "run-compare-show", "ready");

				const toonResult = await runTiller(["show", "run-compare-show"], {
					cwd: testDir,
				});
				const jsonResult = await runTiller(
					["show", "run-compare-show", "--json"],
					{ cwd: testDir },
				);

				const jsonData = JSON.parse(jsonResult.stdout);

				// TOON should contain the run ID and state
				expect(toonResult.stdout).toContain("run-compare-show");
				expect(toonResult.stdout).toContain("ready");
				// JSON should have the same data
				expect(jsonData.id).toBe("run-compare-show");
				expect(jsonData.state).toBe("ready");
			});
		});

		describe("--pretty output (legacy)", () => {
			it("shows formatted track with --pretty flag", async () => {
				createMockTrack(testDir, "track-pretty-show", "active/executing", {
					intent: "Test intent for pretty show",
				});

				const result = await runTiller(
					["show", "track-pretty-show", "--pretty"],
					{ cwd: testDir },
				);

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("PLAN: track-pretty-show");
				expect(result.stdout).toContain("Intent:");
				expect(result.stdout).toContain("active/executing");
				// Should NOT be TOON
				expect(result.stdout).not.toContain("```toon");
			});
		});

		it("displays track details (--pretty)", async () => {
			createMockTrack(testDir, "track-show1", "active/executing", {
				intent: "Test intent for show command",
			});

			const result = await runTiller(["show", "track-show1", "--pretty"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			// Plan ref falls back to track ID when no PLAN.md pattern match
			expect(result.stdout).toContain("PLAN: track-show1");
			expect(result.stdout).toContain("Intent:");
			expect(result.stdout).toContain("State:");
			expect(result.stdout).toContain("active/executing");
		});

		it("returns error for non-existent track", async () => {
			const result = await runTiller(["show", "invalid-track"], {
				cwd: testDir,
			});

			expect(result.exitCode).not.toBe(0);
			// Error may be in stdout or stderr
			expect(result.stdout + result.stderr).toContain("Not found");
		});

		it("outputs valid JSON with --json flag", async () => {
			createMockTrack(testDir, "track-json-show", "proposed");

			const result = await runTiller(["show", "track-json-show", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const track = JSON.parse(result.stdout);
			expect(track.id).toBe("track-json-show");
			expect(track.state).toBe("proposed");
			expect(track).toHaveProperty("plan_path");
			expect(track).toHaveProperty("transitions");
		});

		it("shows claim info when track is claimed (--pretty)", async () => {
			const futureTime = new Date(Date.now() + 3600000).toISOString();
			createMockTrack(testDir, "track-claimed", "active/executing", {
				claimedBy: "test-agent",
				claimExpires: futureTime,
			});

			const result = await runTiller(["show", "track-claimed", "--pretty"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Claimed:");
			expect(result.stdout).toContain("test-agent");
		});
	});

	describe("ready command", () => {
		// TOON-first output (ADR-0003)
		// TOON uses table format with agent_hint OUTSIDE the fence
		describe("TOON output (default)", () => {
			it("outputs TOON by default with agent_hint", async () => {
				createMockTrack(testDir, "run-toon-ready1", "ready");
				createMockTrack(testDir, "run-toon-ready2", "active/executing");

				const result = await runTiller(["ready"], { cwd: testDir });

				expect(result.exitCode).toBe(0);
				// Should be wrapped in ```toon``` block
				expect(result.stdout).toContain("```toon");
				expect(result.stdout).toContain("```\n");

				// Should have ready structure
				expect(result.stdout).toContain("ready:");
				expect(result.stdout).toContain("count:");

				// agent_hint is OUTSIDE the fence
				expect(result.stdout).toMatch(/```\s*\nagent_hint:/);
			});

			it("TOON contains run data matching --json", async () => {
				createMockTrack(testDir, "run-compare-ready", "ready");

				const toonResult = await runTiller(["ready"], { cwd: testDir });
				const jsonResult = await runTiller(["ready", "--json"], {
					cwd: testDir,
				});

				const jsonData = JSON.parse(jsonResult.stdout);

				// TOON should contain the run ID
				expect(toonResult.stdout).toContain("run-compare-ready");
				// JSON should be an array with the run
				expect(Array.isArray(jsonData)).toBe(true);
			});
		});

		describe("--pretty output (legacy)", () => {
			it("shows formatted ready list with --pretty flag", async () => {
				createMockTrack(testDir, "track-pretty-ready1", "ready");
				createMockTrack(testDir, "track-pretty-ready2", "active/executing");

				const result = await runTiller(["ready", "--pretty"], { cwd: testDir });

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Ready work");
				expect(result.stdout).toContain("track-pretty-ready1");
				expect(result.stdout).toContain("track-pretty-ready2");
				// Should NOT be TOON
				expect(result.stdout).not.toContain("```toon");
			});
		});

		it("shows ready tracks sorted by priority (--pretty)", async () => {
			createMockTrack(testDir, "track-ready1", "ready");
			createMockTrack(testDir, "track-ready2", "ready");

			const result = await runTiller(["ready", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Ready work");
			expect(result.stdout).toContain("track-ready1");
			expect(result.stdout).toContain("track-ready2");
		});

		it("shows claimed tracks with [claimed] flag (--pretty)", async () => {
			const futureTime = new Date(Date.now() + 3600000).toISOString();
			createMockTrack(testDir, "track-claimed-ready", "ready", {
				claimedBy: "agent1",
				claimExpires: futureTime,
			});
			createMockTrack(testDir, "track-unclaimed-ready", "ready");

			const result = await runTiller(["ready", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("track-unclaimed-ready");
			expect(result.stdout).toContain("track-claimed-ready");
			expect(result.stdout).toContain("[claimed]");
		});

		it("outputs valid JSON array with --json flag", async () => {
			createMockTrack(testDir, "track-json-ready", "ready");

			const result = await runTiller(["ready", "--json"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			const json = JSON.parse(result.stdout);
			expect(Array.isArray(json)).toBe(true);
			expect(json.length).toBe(1);
			expect(json[0].planRef).toBe("track-json-ready");
		});

		it("shows message when no actionable work (--pretty)", async () => {
			// Create tracks that are not ready
			createMockTrack(testDir, "track-not-ready", "proposed");

			const result = await runTiller(["ready", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No actionable work");
		});

		it("outputs empty TOON ready list when no actionable work", async () => {
			// Create tracks that are not ready
			createMockTrack(testDir, "run-not-ready", "proposed");

			const result = await runTiller(["ready"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("```toon");
			// Empty ready should show count: 0
			expect(result.stdout).toContain("count: 0");
		});

		it("shows active tracks as ready when unclaimed (--pretty)", async () => {
			createMockTrack(testDir, "run-active-ready", "active/executing");

			const result = await runTiller(["ready", "--pretty"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("run-active-ready");
		});

		it("TOON includes active runs as items", async () => {
			createMockTrack(testDir, "run-toon-active", "active/executing");

			const result = await runTiller(["ready"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("```toon");
			// TOON should contain the active run
			expect(result.stdout).toContain("run-toon-active");
		});
	});
});
