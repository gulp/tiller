/**
 * E2E tests for Tiller mate commands - Multi-agent worker coordination
 *
 * Tests:
 * - mate add <name>     - Add a new mate to the registry
 * - mate list           - Show all mates
 * - mate status <name>  - Detailed mate view
 * - mate remove <name>  - Remove a mate from registry
 * - mate claim <name>   - Claim mate identity for session
 * - mate unclaim        - Release claimed mate identity
 * - mate gc             - Garbage collect stale mates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller mate commands", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create mates directory
		mkdirSync(join(testDir, ".tiller", "mates"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("mate add", () => {
		it("adds a new mate to the registry", async () => {
			const result = await runTiller(["mate", "add", "worker-1"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Added mate: worker-1");
			expect(result.stdout).toContain("State: available");

			// Verify mate file was created
			const mateFile = join(testDir, ".tiller", "mates", "worker-1.json");
			expect(existsSync(mateFile)).toBe(true);

			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			expect(mate.name).toBe("worker-1");
			expect(mate.state).toBe("available");
		});

		it("rejects duplicate mate names", async () => {
			// First add should succeed
			await runTiller(["mate", "add", "duplicate"], { cwd: testDir });

			// Second add with same name should fail
			const result = await runTiller(["mate", "add", "duplicate"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Error");
		});

		it("creates mate with correct initial state", async () => {
			await runTiller(["mate", "add", "fresh-mate"], { cwd: testDir });

			const mateFile = join(testDir, ".tiller", "mates", "fresh-mate.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));

			expect(mate.state).toBe("available");
			expect(mate.assignedPlan).toBe(null);
			expect(mate.claimedBy).toBe(null);
			expect(mate.createdAt).toBeDefined();
			expect(mate.updatedAt).toBeDefined();
		});
	});

	describe("mate list", () => {
		it("shows no mates when registry is empty", async () => {
			const result = await runTiller(["mate", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No mates registered");
			expect(result.stdout).toContain("tiller mate add");
		});

		it("lists registered mates", async () => {
			// Add multiple mates
			await runTiller(["mate", "add", "alpha"], { cwd: testDir });
			await runTiller(["mate", "add", "beta"], { cwd: testDir });

			const result = await runTiller(["mate", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Mates:");
			expect(result.stdout).toContain("alpha");
			expect(result.stdout).toContain("beta");
			expect(result.stdout).toContain("[available]");
		});

		it("outputs JSON with --json flag", async () => {
			await runTiller(["mate", "add", "json-mate"], { cwd: testDir });

			const result = await runTiller(["mate", "list", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const mates = JSON.parse(result.stdout);
			expect(Array.isArray(mates)).toBe(true);
			expect(mates.length).toBe(1);
			expect(mates[0].name).toBe("json-mate");
		});

		it("shows assigned plans in list output", async () => {
			// Add mate and manually set assignedPlan
			await runTiller(["mate", "add", "assigned-mate"], { cwd: testDir });

			const mateFile = join(testDir, ".tiller", "mates", "assigned-mate.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.assignedPlan = "07-01";
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(["mate", "list"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("07-01");
		});
	});

	describe("mate status", () => {
		it("shows detailed mate information", async () => {
			await runTiller(["mate", "add", "detailed-mate"], { cwd: testDir });

			const result = await runTiller(["mate", "status", "detailed-mate"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Mate: detailed-mate");
			expect(result.stdout).toContain("State: available");
			expect(result.stdout).toContain("Assigned:");
			expect(result.stdout).toContain("Claimed by:");
			expect(result.stdout).toContain("Created:");
			expect(result.stdout).toContain("Updated:");
		});

		it("returns error for non-existent mate", async () => {
			const result = await runTiller(["mate", "status", "ghost"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Mate not found: ghost");
		});

		it("shows (none) for unassigned plan", async () => {
			await runTiller(["mate", "add", "unassigned"], { cwd: testDir });

			const result = await runTiller(["mate", "status", "unassigned"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assigned: (none)");
		});

		it("shows (unclaimed) when not claimed", async () => {
			await runTiller(["mate", "add", "free-mate"], { cwd: testDir });

			const result = await runTiller(["mate", "status", "free-mate"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("(unclaimed)");
		});
	});

	describe("mate remove", () => {
		it("removes a mate from registry", async () => {
			await runTiller(["mate", "add", "to-remove"], { cwd: testDir });

			const result = await runTiller(["mate", "remove", "to-remove"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removed mate: to-remove");

			// Verify file is gone
			const mateFile = join(testDir, ".tiller", "mates", "to-remove.json");
			expect(existsSync(mateFile)).toBe(false);
		});

		it("returns error for non-existent mate", async () => {
			const result = await runTiller(["mate", "remove", "nonexistent"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Error");
		});
	});

	describe("mate claim", () => {
		it("claims an available mate", async () => {
			await runTiller(["mate", "add", "claimable"], { cwd: testDir });

			const result = await runTiller(["mate", "claim", "claimable"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Claimed: claimable");
			expect(result.stdout).toContain("PID:");

			// Verify mate state updated
			const mateFile = join(testDir, ".tiller", "mates", "claimable.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			expect(mate.state).toBe("claimed");
			expect(mate.claimedBy).toBeDefined();
		});

		it("returns error for non-existent mate", async () => {
			const result = await runTiller(["mate", "claim", "missing-mate"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Mate not found: missing-mate");
			expect(result.stderr).toContain("Available mates");
		});

		it("shows next steps when mate has assigned plan", async () => {
			await runTiller(["mate", "add", "with-plan"], { cwd: testDir });

			// Assign a plan to the mate
			const mateFile = join(testDir, ".tiller", "mates", "with-plan.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.assignedPlan = "08-01";
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(["mate", "claim", "with-plan"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assigned: 08-01");
			expect(result.stdout).toContain("tiller sail");
		});

		it("shows waiting message when no plan assigned", async () => {
			await runTiller(["mate", "add", "no-plan"], { cwd: testDir });

			const result = await runTiller(["mate", "claim", "no-plan"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assigned: (none)");
			expect(result.stdout).toContain("Waiting for orchestrator");
			expect(result.stdout).toContain("tiller assign");
		});

		it("reclaims mate when previous owner process is gone", async () => {
			await runTiller(["mate", "add", "stale-claim"], { cwd: testDir });

			// Simulate stale claim by setting claimedBy to invalid PID
			const mateFile = join(testDir, ".tiller", "mates", "stale-claim.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.state = "claimed";
			mate.claimedBy = 999999; // Invalid PID
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(["mate", "claim", "stale-claim"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Reclaiming stale mate");
			expect(result.stdout).toContain("Claimed: stale-claim");
		});
	});

	describe("mate gc", () => {
		it("reports no stale mates when none exist", async () => {
			await runTiller(["mate", "add", "healthy"], { cwd: testDir });

			const result = await runTiller(["mate", "gc"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No stale mates found");
		});

		it("shows what would be released with --dry-run", async () => {
			await runTiller(["mate", "add", "stale-gc"], { cwd: testDir });

			// Simulate stale claim
			const mateFile = join(testDir, ".tiller", "mates", "stale-gc.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.state = "claimed";
			mate.claimedBy = 999998;
			mate.claimedBySession = "old-session-12345678";
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(["mate", "gc", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Stale mates (dry run)");
			expect(result.stdout).toContain("stale-gc");
			expect(result.stdout).toContain("Run without --dry-run");
		});

		it("releases stale mates on gc", async () => {
			await runTiller(["mate", "add", "to-release"], { cwd: testDir });

			// Simulate stale claim
			const mateFile = join(testDir, ".tiller", "mates", "to-release.json");
			const mate = JSON.parse(readFileSync(mateFile, "utf-8"));
			mate.state = "claimed";
			mate.claimedBy = 999997;
			mate.claimedBySession = "dead-session-12345678";
			writeFileSync(mateFile, JSON.stringify(mate, null, 2));

			const result = await runTiller(["mate", "gc"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Released");
			expect(result.stdout).toContain("to-release");

			// Verify mate is now available
			const updatedMate = JSON.parse(readFileSync(mateFile, "utf-8"));
			expect(updatedMate.state).toBe("available");
			expect(updatedMate.claimedBy).toBe(null);
		});
	});
});
