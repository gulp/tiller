/**
 * E2E tests for Tiller codebase commands
 *
 * Tests the codebase analysis command that outputs TOON configurations
 * for parallel Explore agent spawning.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestEnv, createTestEnv, runTiller } from "../helpers";

describe("tiller codebase map command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
		// Create a minimal codebase structure
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(join(testDir, "src", "index.ts"), "export const x = 1;");
		writeFileSync(join(testDir, "src", "utils.ts"), "export const y = 2;");
		writeFileSync(join(testDir, "src", "main.ts"), "console.log('main');");
		writeFileSync(join(testDir, "src", "config.ts"), "export const config = {};");
		writeFileSync(join(testDir, "src", "api.ts"), "export const api = {};");
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	describe("basic output", () => {
		it("outputs TOON format by default", async () => {
			const result = await runTiller(["codebase", "map"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("```toon");
			expect(result.stdout).toContain("codebase_map:");
			expect(result.stdout).toContain("output_dir:");
			// TOON format uses compressed notation like agents[4\t]:
			expect(result.stdout).toMatch(/agents\[\d/);
		});

		it("includes all 7 document types", async () => {
			const result = await runTiller(["codebase", "map", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const data = JSON.parse(result.stdout);
			expect(data.codebase_map.documents).toHaveLength(7);
			expect(data.codebase_map.documents).toContain("STACK.md");
			expect(data.codebase_map.documents).toContain("ARCHITECTURE.md");
			expect(data.codebase_map.documents).toContain("STRUCTURE.md");
			expect(data.codebase_map.documents).toContain("CONVENTIONS.md");
			expect(data.codebase_map.documents).toContain("TESTING.md");
			expect(data.codebase_map.documents).toContain("INTEGRATIONS.md");
			expect(data.codebase_map.documents).toContain("CONCERNS.md");
		});

		it("includes 4 agent configurations", async () => {
			const result = await runTiller(["codebase", "map", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const data = JSON.parse(result.stdout);
			expect(data.codebase_map.agents).toHaveLength(4);

			// Verify agent structure
			const agent1 = data.codebase_map.agents[0];
			expect(agent1.id).toBe(1);
			expect(agent1.name).toBe("Stack + Integrations");
			expect(agent1.focus).toBeInstanceOf(Array);
			expect(agent1.outputs).toContain("STACK.md");
			expect(agent1.prompt).toBeTruthy();
		});

		it("includes agent hints in TOON output", async () => {
			const result = await runTiller(["codebase", "map"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("agent_hint:");
			expect(result.stdout).toContain("Spawn 4 parallel Explore agents");
		});
	});

	describe("--json flag", () => {
		it("outputs raw JSON", async () => {
			const result = await runTiller(["codebase", "map", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(() => JSON.parse(result.stdout)).not.toThrow();

			const data = JSON.parse(result.stdout);
			expect(data.codebase_map).toBeDefined();
			expect(data.codebase_map.action).toBe("create");
		});
	});

	describe("--pretty flag", () => {
		it("outputs human-readable format", async () => {
			const result = await runTiller(["codebase", "map", "--pretty"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Codebase Map Command");
			expect(result.stdout).toContain("Action: Create");
			expect(result.stdout).toContain("Documents to generate:");
			expect(result.stdout).toContain("Parallel agents:");
		});
	});

	describe("--focus flag", () => {
		it("includes focus area in output", async () => {
			const result = await runTiller(["codebase", "map", "--focus", "api", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const data = JSON.parse(result.stdout);
			expect(data.codebase_map.focus_area).toBe("api");
		});

		it("customizes agent prompts for focus area", async () => {
			const result = await runTiller(["codebase", "map", "--focus", "authentication", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const data = JSON.parse(result.stdout);

			// All agent prompts should include the focus area
			for (const agent of data.codebase_map.agents) {
				expect(agent.prompt).toContain("FOCUS AREA: authentication");
			}
		});
	});

	describe("--dry-run flag", () => {
		it("shows what would be created with --create-dir", async () => {
			const result = await runTiller(["codebase", "map", "--create-dir", "--dry-run"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Would create:");
			expect(result.stdout).toContain(".planning/codebase");

			// Verify directory was not created
			expect(existsSync(join(testDir, ".planning", "codebase"))).toBe(false);
		});
	});

	describe("--create-dir flag", () => {
		it("creates .planning/codebase/ directory", async () => {
			const result = await runTiller(["codebase", "map", "--create-dir"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Created:");
			expect(existsSync(join(testDir, ".planning", "codebase"))).toBe(true);
		});

		it("does not error if directory already exists", async () => {
			mkdirSync(join(testDir, ".planning", "codebase"), { recursive: true });

			const result = await runTiller(["codebase", "map", "--create-dir"], {
				cwd: testDir,
			});

			// Should succeed without error (mkdir recursive handles existing dirs)
			expect(result.exitCode).toBe(0);
		});
	});

	describe("existing documents handling", () => {
		it("reports skip action when documents exist", async () => {
			// Create existing codebase docs
			const codebaseDir = join(testDir, ".planning", "codebase");
			mkdirSync(codebaseDir, { recursive: true });
			writeFileSync(join(codebaseDir, "STACK.md"), "# Stack\n");
			writeFileSync(join(codebaseDir, "ARCHITECTURE.md"), "# Arch\n");

			const result = await runTiller(["codebase", "map", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const data = JSON.parse(result.stdout);
			expect(data.codebase_map.action).toBe("skip");
			expect(data.codebase_map.existing_docs).toContain("STACK.md");
			expect(data.codebase_map.existing_docs).toContain("ARCHITECTURE.md");
		});

		it("shows helpful message in TOON when documents exist", async () => {
			const codebaseDir = join(testDir, ".planning", "codebase");
			mkdirSync(codebaseDir, { recursive: true });
			writeFileSync(join(codebaseDir, "STACK.md"), "# Stack\n");

			const result = await runTiller(["codebase", "map"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("already exist");
			expect(result.stdout).toContain("--refresh");
		});
	});

	describe("--refresh flag", () => {
		it("sets action to refresh when documents exist", async () => {
			const codebaseDir = join(testDir, ".planning", "codebase");
			mkdirSync(codebaseDir, { recursive: true });
			writeFileSync(join(codebaseDir, "STACK.md"), "# Stack\n");

			const result = await runTiller(["codebase", "map", "--refresh", "--json"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			const data = JSON.parse(result.stdout);
			expect(data.codebase_map.action).toBe("refresh");
		});

		it("shows refresh action in pretty output", async () => {
			const codebaseDir = join(testDir, ".planning", "codebase");
			mkdirSync(codebaseDir, { recursive: true });
			writeFileSync(join(codebaseDir, "STACK.md"), "# Stack\n");

			const result = await runTiller(["codebase", "map", "--refresh", "--pretty"], {
				cwd: testDir,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Action: Refresh");
		});
	});
});

describe("tiller codebase status command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("reports no documents when directory does not exist", async () => {
		const result = await runTiller(["codebase", "status", "--json"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		const data = JSON.parse(result.stdout);
		expect(data.exists).toBe(false);
		expect(data.documents.existing).toHaveLength(0);
		expect(data.documents.missing).toHaveLength(7);
		expect(data.documents.complete).toBe(false);
	});

	it("reports partial documents when some exist", async () => {
		const codebaseDir = join(testDir, ".planning", "codebase");
		mkdirSync(codebaseDir, { recursive: true });
		writeFileSync(join(codebaseDir, "STACK.md"), "# Stack\n");
		writeFileSync(join(codebaseDir, "ARCHITECTURE.md"), "# Arch\n");

		const result = await runTiller(["codebase", "status", "--json"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		const data = JSON.parse(result.stdout);
		expect(data.exists).toBe(true);
		expect(data.documents.existing).toHaveLength(2);
		expect(data.documents.missing).toHaveLength(5);
		expect(data.documents.complete).toBe(false);
	});

	it("reports complete when all documents exist", async () => {
		const codebaseDir = join(testDir, ".planning", "codebase");
		mkdirSync(codebaseDir, { recursive: true });
		const docs = [
			"STACK.md",
			"ARCHITECTURE.md",
			"STRUCTURE.md",
			"CONVENTIONS.md",
			"TESTING.md",
			"INTEGRATIONS.md",
			"CONCERNS.md",
		];
		for (const doc of docs) {
			writeFileSync(join(codebaseDir, doc), `# ${doc}\n`);
		}

		const result = await runTiller(["codebase", "status", "--json"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		const data = JSON.parse(result.stdout);
		expect(data.documents.complete).toBe(true);
		expect(data.documents.missing).toHaveLength(0);
	});

	it("outputs TOON with agent hint by default", async () => {
		const result = await runTiller(["codebase", "status"], { cwd: testDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("```toon");
		expect(result.stdout).toContain("agent_hint:");
		expect(result.stdout).toContain("tiller codebase map");
	});
});

describe("tiller codebase --help", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("shows help for codebase command", async () => {
		const result = await runTiller(["codebase", "--help"], { cwd: testDir });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Codebase analysis commands");
		expect(result.stdout).toContain("map");
		expect(result.stdout).toContain("status");
	});

	it("shows help for codebase map subcommand", async () => {
		const result = await runTiller(["codebase", "map", "--help"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("--focus");
		expect(result.stdout).toContain("--refresh");
		expect(result.stdout).toContain("--dry-run");
		expect(result.stdout).toContain("--json");
		expect(result.stdout).toContain("--pretty");
		expect(result.stdout).toContain("--create-dir");
	});
});
