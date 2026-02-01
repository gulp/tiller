/**
 * E2E tests for Tiller focus command - Session-scoped initiative focus
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller focus command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create initiative directories in .planning/phases (as per config.paths.plans)
		mkdirSync(join(testDir, ".planning", "phases", "tiller-cli", "01-test"), { recursive: true });
		mkdirSync(join(testDir, ".planning", "phases", "dogfooding", "01-test"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("focus set", () => {
		it("sets working_initiative when given valid initiative", async () => {
			const result = await runTiller(["focus", "tiller-cli"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("focus:");
			expect(result.stdout).toContain("initiative: tiller-cli");
			expect(result.stdout).toContain('action: set');
			expect(result.stdout).toContain("Focused on tiller-cli");
		});

		it("errors on non-existent initiative with suggestions", async () => {
			const result = await runTiller(["focus", "nonexistent"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("focus_error:");
			expect(result.stdout).toContain("initiative_not_found");
			expect(result.stdout).toContain("tiller-cli");
			expect(result.stdout).toContain("dogfooding");
		});

		it("persists focus in config file", async () => {
			await runTiller(["focus", "tiller-cli"], { cwd: testDir });

			const configPath = join(testDir, ".tiller", "tiller.toml");
			const configContent = readFileSync(configPath, "utf-8");
			expect(configContent).toContain("working_initiative");
			expect(configContent).toContain("tiller-cli");
		});
	});

	describe("focus show (no argument)", () => {
		it("shows current focus when set", async () => {
			// First set focus
			await runTiller(["focus", "tiller-cli"], { cwd: testDir });

			// Then check show
			const result = await runTiller(["focus"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("focus:");
			expect(result.stdout).toContain("initiative: tiller-cli");
			expect(result.stdout).toContain('action: show');
			expect(result.stdout).toContain("Currently focused on tiller-cli");
		});

		it("shows no focus when not set", async () => {
			// Explicitly clear any focus first
			await runTiller(["unfocus"], { cwd: testDir });

			const result = await runTiller(["focus"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("focus:");
			expect(result.stdout).toContain("initiative: null");
			expect(result.stdout).toContain("No initiative focused");
		});
	});

	describe("unfocus", () => {
		it("clears working_initiative", async () => {
			// First set focus
			await runTiller(["focus", "tiller-cli"], { cwd: testDir });

			// Then unfocus
			const result = await runTiller(["unfocus"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("focus:");
			expect(result.stdout).toContain("initiative: null");
			expect(result.stdout).toContain("previous: tiller-cli");
			expect(result.stdout).toContain('action: clear');
			expect(result.stdout).toContain("Focus cleared");
		});

		it("unfocus when already unfocused is idempotent", async () => {
			const result = await runTiller(["unfocus"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("focus:");
			expect(result.stdout).toContain("initiative: null");
		});
	});

	describe("prime clears focus", () => {
		it("clears focus on prime", async () => {
			// First set focus
			await runTiller(["focus", "tiller-cli"], { cwd: testDir });

			// Verify focus is set
			let result = await runTiller(["focus"], { cwd: testDir });
			expect(result.stdout).toContain("initiative: tiller-cli");

			// Run prime
			await runTiller(["prime"], { cwd: testDir });

			// Verify focus is cleared
			result = await runTiller(["focus"], { cwd: testDir });
			expect(result.stdout).toContain("initiative: null");
		});
	});

	describe("plan create blocks when unfocused", () => {
		it("blocks plan create when no initiative focused and no flag", async () => {
			// Ensure no focus
			await runTiller(["unfocus"], { cwd: testDir });

			const result = await runTiller(
				["plan", "create", "Test objective", "--phase", "01"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain("plan_create_error:");
			expect(result.stdout).toContain("no_initiative_focused");
			expect(result.stdout).toContain("tiller focus");
		});

		it("allows plan create with --initiative flag when unfocused", async () => {
			// Ensure no focus
			await runTiller(["unfocus"], { cwd: testDir });

			const result = await runTiller(
				["plan", "create", "Test objective", "--phase", "01", "--initiative", "tiller-cli"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created:");
		});

		it("allows plan create when focused", async () => {
			// Set focus
			await runTiller(["focus", "tiller-cli"], { cwd: testDir });

			const result = await runTiller(
				["plan", "create", "Test objective", "--phase", "01"],
				{ cwd: testDir },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created:");
			expect(result.stdout).toContain("tiller-cli");
		});
	});
});
