/**
 * E2E tests for Tiller setup command - Install hooks for Claude Code
 *
 * Commands:
 * - setup claude    - Install hooks for Claude Code integration
 * - setup --list    - Show what hooks would be installed
 * - setup --remove  - Remove installed hooks
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";
import { cleanupTestDirectory, createTestDirectory } from "../setup";

describe("tiller setup command", () => {
	let bootstrapTestDir: string;

	beforeEach(async () => {
		bootstrapTestDir = await createTestEnv();
		// Create .claude directory for local settings
		mkdirSync(join(bootstrapTestDir, ".claude"), { recursive: true });
	});

	afterEach(async () => {
		await cleanupTestEnv(bootstrapTestDir);
	});

	describe("setup claude", () => {
		it("installs hooks when .claude directory exists", async () => {
			const result = await runTiller(["setup", "claude"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			// Check settings file was created
			const settingsPath = join(bootstrapTestDir, ".claude", "settings.local.json");
			expect(existsSync(settingsPath)).toBe(true);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(settings.hooks).toBeDefined();
		});

		it("adds SessionStart hook with tiller prime", async () => {
			const result = await runTiller(["setup", "claude"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			const settingsPath = join(bootstrapTestDir, ".claude", "settings.local.json");
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

			expect(settings.hooks?.SessionStart).toBeDefined();
			const hasTimerPrime = settings.hooks.SessionStart.some(
				(entry: { hooks?: Array<{ command: string }> }) =>
					entry.hooks?.some((h) => h.command.includes("tiller prime")),
			);
			expect(hasTimerPrime).toBe(true);
		});

		it("does not duplicate hooks if already installed", async () => {
			// Run setup twice
			await runTiller(["setup", "claude"], { cwd: bootstrapTestDir });
			const result = await runTiller(["setup", "claude"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			const settingsPath = join(bootstrapTestDir, ".claude", "settings.local.json");
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

			// Should only have one tiller prime hook
			const primeHooks = settings.hooks.SessionStart.filter(
				(entry: { hooks?: Array<{ command: string }> }) =>
					entry.hooks?.some((h) => h.command.includes("tiller prime")),
			);
			expect(primeHooks.length).toBe(1);
		});

		it("preserves existing settings when adding hooks", async () => {
			// Create existing settings
			const settingsPath = join(bootstrapTestDir, ".claude", "settings.local.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({ customSetting: "preserved" }, null, 2),
			);

			const result = await runTiller(["setup", "claude"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(settings.customSetting).toBe("preserved");
			expect(settings.hooks).toBeDefined();
		});
	});

	describe("setup --dry-run", () => {
		it("shows what hooks would be installed", async () => {
			const result = await runTiller(["setup", "claude", "--dry-run"], {
				cwd: bootstrapTestDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("SessionStart");
		});
	});

	describe("setup --scope", () => {
		it("supports local scope (default)", async () => {
			const result = await runTiller(["setup", "claude", "--scope", "local"], {
				cwd: bootstrapTestDir,
			});

			expect(result.exitCode).toBe(0);

			const settingsPath = join(bootstrapTestDir, ".claude", "settings.local.json");
			expect(existsSync(settingsPath)).toBe(true);
		});

		it("supports project scope", async () => {
			const result = await runTiller(
				["setup", "claude", "--scope", "project"],
				{
					cwd: bootstrapTestDir,
				},
			);

			expect(result.exitCode).toBe(0);

			const settingsPath = join(bootstrapTestDir, ".claude", "settings.json");
			expect(existsSync(settingsPath)).toBe(true);
		});
	});

	describe("setup help", () => {
		it("shows help text", async () => {
			const result = await runTiller(["setup", "--help"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("setup");
		});
	});

	describe("setup bootstrap", () => {
		// Use empty test dir (not createTestEnv) since bootstrap creates .tiller/
		let bootstrapTestDir: string;

		beforeEach(() => {
			bootstrapTestDir = createTestDirectory("tiller-bootstrap-test-");
		});

		afterEach(() => {
			cleanupTestDirectory(bootstrapTestDir);
		});

		it("creates directory structure", async () => {
			const result = await runTiller(["setup", "bootstrap"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			// Check directories were created
			expect(existsSync(join(bootstrapTestDir, ".tiller"))).toBe(true);
			expect(existsSync(join(bootstrapTestDir, "plans"))).toBe(true);
			expect(existsSync(join(bootstrapTestDir, "specs"))).toBe(true);
			expect(existsSync(join(bootstrapTestDir, "plans", "todos"))).toBe(true);
		});

		it("creates config files", async () => {
			const result = await runTiller(["setup", "bootstrap"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			// Check config files
			expect(existsSync(join(bootstrapTestDir, ".tiller", "tiller.toml"))).toBe(true);
			expect(existsSync(join(bootstrapTestDir, ".tiller", "PRIME.md"))).toBe(true);
		});

		it("creates .gitignore with tiller entries", async () => {
			const result = await runTiller(["setup", "bootstrap"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			const gitignorePath = join(bootstrapTestDir, ".gitignore");
			expect(existsSync(gitignorePath)).toBe(true);

			const gitignore = readFileSync(gitignorePath, "utf-8");
			expect(gitignore).toContain(".tiller/tracks/");
			expect(gitignore).toContain(".tiller/agents/");
		});

		it("creates sample files with --with-samples", async () => {
			const result = await runTiller(["setup", "bootstrap"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			// Check sample spec (approved state with .lock suffix)
			expect(existsSync(join(bootstrapTestDir, "specs", "0001-dark-mode.lock", "scope.md"))).toBe(true);
			expect(existsSync(join(bootstrapTestDir, "specs", "hero-section", "scope.md"))).toBe(true);

			// Check sample plan
			expect(existsSync(join(bootstrapTestDir, "plans", "example-init", "01-phase", "01-01-PLAN.md"))).toBe(true);

			// Check src-sample
			expect(existsSync(join(bootstrapTestDir, "src-sample", "demo.html"))).toBe(true);

			// Check QUICKSTART.md
			expect(existsSync(join(bootstrapTestDir, "QUICKSTART.md"))).toBe(true);
		});

		it("skips sample files with --no-with-samples", async () => {
			const result = await runTiller(["setup", "bootstrap", "--no-with-samples"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			// Directories should exist
			expect(existsSync(join(bootstrapTestDir, ".tiller"))).toBe(true);
			expect(existsSync(join(bootstrapTestDir, "plans"))).toBe(true);
			expect(existsSync(join(bootstrapTestDir, "specs"))).toBe(true);

			// Sample files should NOT exist
			expect(existsSync(join(bootstrapTestDir, "specs", "example-feature"))).toBe(false);
			expect(existsSync(join(bootstrapTestDir, "plans", "example-init"))).toBe(false);
			expect(existsSync(join(bootstrapTestDir, "QUICKSTART.md"))).toBe(false);
		});

		it("shows what would be created with --dry-run", async () => {
			const result = await runTiller(["setup", "bootstrap", "--dry-run"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Would create:");
			expect(result.stdout).toContain(".tiller");
			expect(result.stdout).toContain("plans");
			expect(result.stdout).toContain("specs");

			// Nothing should actually be created
			expect(existsSync(join(bootstrapTestDir, ".tiller"))).toBe(false);
			expect(existsSync(join(bootstrapTestDir, "plans"))).toBe(false);
		});

		it("is idempotent - does not fail if files exist", async () => {
			// Run bootstrap twice
			await runTiller(["setup", "bootstrap"], { cwd: bootstrapTestDir });
			const result = await runTiller(["setup", "bootstrap"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("already bootstrapped");
		});

		it("appends to existing .gitignore", async () => {
			// Create existing .gitignore
			const gitignorePath = join(bootstrapTestDir, ".gitignore");
			writeFileSync(gitignorePath, "node_modules/\n*.log\n");

			const result = await runTiller(["setup", "bootstrap"], { cwd: bootstrapTestDir });

			expect(result.exitCode).toBe(0);

			const gitignore = readFileSync(gitignorePath, "utf-8");
			// Should preserve existing content
			expect(gitignore).toContain("node_modules/");
			expect(gitignore).toContain("*.log");
			// Should add tiller entries
			expect(gitignore).toContain(".tiller/tracks/");
		});
	});
});
