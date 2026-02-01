/**
 * E2E tests for Tiller constitutional command - Manage constitutional knowledge files
 *
 * Commands:
 * - constitutional       - Show constitutional knowledge files
 * - constitutional --init - Initialize default constitutional files
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller constitutional command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("constitutional (show)", () => {
		it("prompts to init when no constitutional files exist", async () => {
			const result = await runTiller(["constitutional"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No constitutional files");
			expect(result.stdout).toContain("tiller constitutional --init");
		});

		it("displays constitutional files when they exist", async () => {
			// Create a constitutional file
			const constitutionalDir = join(testDir, ".tiller", "constitutional");
			mkdirSync(constitutionalDir, { recursive: true });
			writeFileSync(
				join(constitutionalDir, "principles.md"),
				"# Core Principles\n\nWrite clean, maintainable code.",
			);

			const result = await runTiller(["constitutional"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			// Should output the constitutional content
			expect(result.stdout).toContain("Core Principles");
		});
	});

	describe("constitutional --init", () => {
		it("initializes default constitutional files", async () => {
			const constitutionalDir = join(testDir, ".tiller", "constitutional");

			// Directory shouldn't exist yet
			expect(existsSync(constitutionalDir)).toBe(false);

			const result = await runTiller(["constitutional", "--init"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Initialized constitutional files");
			expect(existsSync(constitutionalDir)).toBe(true);
		});

		it("creates constitutional directory structure", async () => {
			await runTiller(["constitutional", "--init"], { cwd: testDir });

			const constitutionalDir = join(testDir, ".tiller", "constitutional");
			expect(existsSync(constitutionalDir)).toBe(true);
		});
	});
});
