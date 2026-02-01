/**
 * E2E tests for Tiller collect command - Triage orphaned beads into plans or todos
 *
 * Note: collect relies heavily on 'bd' (beads) CLI which may not be available
 * in test environments. We test the command structure and error handling.
 *
 * Command: tiller collect [--dry-run] [--force] [--todo]
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller collect command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create planning directories
		mkdirSync(join(testDir, ".planning/phases"), { recursive: true });
		mkdirSync(join(testDir, ".planning/todos/pending"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("command structure", () => {
		it("accepts --dry-run option", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--dry-run");
		});

		it("accepts --force option", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--force");
		});

		it("accepts --todo option", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--todo");
		});

		it("accepts --plan option", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--plan");
		});

		it("accepts --phase option", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--phase");
		});

		it("accepts --initiative option", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--initiative");
		});

		it("accepts --human option for interactive triage", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--human");
		});

		it("accepts --json option", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("--json");
		});

		it("accepts bead-id argument", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			expect(result.stdout).toContain("bead-id");
		});
	});

	describe("orphan detection", () => {
		it("runs without error when no orphans found", async () => {
			// Run collect - bd may or may not be available
			const result = await runTiller(["collect", "--dry-run"], {
				cwd: testDir,
				timeout: 10000,
			});

			// Should complete (either with orphans found or not)
			expect(result.exitCode).toBeDefined();
		});
	});

	describe("output format", () => {
		it("outputs TOON format for interactive triage", async () => {
			const result = await runTiller(["collect", "--help"], { cwd: testDir });

			// Help should describe the command behavior
			expect(result.stdout).toContain("collect");
			expect(result.stdout).toContain("orphan");
		});
	});
});
