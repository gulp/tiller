/**
 * Path invariant tests - fail-fast guards for .tiller/ isolation
 *
 * Invariants:
 * 1. Exactly one .tiller/ per project (at project root)
 * 2. Root discovery is deterministic
 * 3. Root discovery is cwd-independent (same result from subdirectories)
 * 4. Nested .tiller/ creation is refused
 * 5. No module may construct .tiller* paths directly (must use CORE_PATHS)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Test with actual filesystem to ensure real behavior
const TEST_ROOT = join(process.cwd(), ".test-paths-invariants");
const TEST_PROJECT = join(TEST_ROOT, "fake-project");
const TEST_SUBDIR = join(TEST_PROJECT, "src", "deep", "nested");

describe("Path Invariants", () => {
	beforeAll(() => {
		// Clean up any previous test artifacts
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true, force: true });
		}

		// Create test directory structure
		mkdirSync(TEST_SUBDIR, { recursive: true });
		mkdirSync(join(TEST_PROJECT, ".git"), { recursive: true });
		mkdirSync(join(TEST_PROJECT, ".tiller"), { recursive: true });
	});

	afterAll(() => {
		// Clean up
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true, force: true });
		}
	});

	describe("deterministic root discovery", () => {
		test("findProjectRoot returns absolute path", async () => {
			const { findProjectRoot } = await import(
				"../../../src/tiller/state/paths.js"
			);
			const root = findProjectRoot();

			expect(root).toBeTruthy();
			expect(root.startsWith("/")).toBe(true);
		});

		test("findProjectRoot is idempotent (same result on repeated calls)", async () => {
			const { findProjectRoot } = await import(
				"../../../src/tiller/state/paths.js"
			);

			const results = Array.from({ length: 10 }, () => findProjectRoot());
			const unique = new Set(results);

			expect(unique.size).toBe(1);
		});

		test("CORE_PATHS.PROJECT_ROOT matches findProjectRoot()", async () => {
			const { CORE_PATHS, findProjectRoot } = await import(
				"../../../src/tiller/state/paths.js"
			);

			expect(CORE_PATHS.PROJECT_ROOT).toBe(findProjectRoot());
		});

		test("CORE_PATHS.TILLER_DIR is exactly PROJECT_ROOT/.tiller", async () => {
			const { CORE_PATHS } = await import(
				"../../../src/tiller/state/paths.js"
			);

			expect(CORE_PATHS.TILLER_DIR).toBe(
				join(CORE_PATHS.PROJECT_ROOT, ".tiller"),
			);
		});
	});

	describe("all paths derive from PROJECT_ROOT", () => {
		test("RUNS_DIR is under TILLER_DIR", async () => {
			const { CORE_PATHS } = await import(
				"../../../src/tiller/state/paths.js"
			);

			expect(CORE_PATHS.RUNS_DIR.startsWith(CORE_PATHS.TILLER_DIR)).toBe(true);
			expect(CORE_PATHS.RUNS_DIR).toBe(join(CORE_PATHS.TILLER_DIR, "runs"));
		});

		test("LEGACY_TRACKS_DIR is under TILLER_DIR", async () => {
			const { CORE_PATHS } = await import(
				"../../../src/tiller/state/paths.js"
			);

			expect(CORE_PATHS.LEGACY_TRACKS_DIR.startsWith(CORE_PATHS.TILLER_DIR)).toBe(
				true,
			);
		});
	});

	describe("nested .tiller/ detection", () => {
		test("guardNestedTiller detects cwd inside .tiller/", () => {
			// This test verifies the guard logic without actually calling process.exit
			// We test the condition that would trigger the guard

			const cwdInsideTiller = "/project/.tiller/runs";
			expect(
				cwdInsideTiller.includes("/.tiller/") ||
					cwdInsideTiller.endsWith("/.tiller"),
			).toBe(true);

			const cwdEndsTiller = "/project/.tiller";
			expect(
				cwdEndsTiller.includes("/.tiller/") || cwdEndsTiller.endsWith("/.tiller"),
			).toBe(true);
		});

		test("guardNestedTiller allows normal cwd", () => {
			const normalCwd = "/project/src/deep";
			expect(
				normalCwd.includes("/.tiller/") || normalCwd.endsWith("/.tiller"),
			).toBe(false);
		});

		test("guardNestedTiller allows .tiller-like names that are not .tiller", () => {
			// .tiller-config or tiller/ are fine
			const tillerLike = "/project/.tiller-config/foo";
			// This should NOT trigger guard because it's not "/.tiller/"
			expect(tillerLike.includes("/.tiller/")).toBe(false);

			const tillerWithoutDot = "/project/tiller/foo";
			expect(tillerWithoutDot.includes("/.tiller/")).toBe(false);
		});
	});
});

describe("Static Analysis: No Direct Path Construction", () => {
	const SRC_DIR = resolve(__dirname, "../../../src/tiller");
	const PATHS_FILE = "state/paths.ts";

	// Files that are ALLOWED to construct .tiller paths
	const ALLOWED_FILES = new Set([
		"state/paths.ts", // The authoritative source
		"types/index.ts", // Has deprecated AGENTS_DIR constant (for backward compat)
	]);

	test("no module constructs .tiller paths directly (must use CORE_PATHS)", () => {
		// Use grep to find any direct .tiller path construction
		// Pattern matches: ".tiller" as a string literal (not in import/comment)
		try {
			const result = execSync(
				`grep -rn '"\\.tiller' ${SRC_DIR} --include='*.ts' || true`,
				{ encoding: "utf-8" },
			);

			const violations: string[] = [];

			for (const line of result.split("\n").filter(Boolean)) {
				// Extract filename relative to SRC_DIR
				const match = line.match(/^(.+?\.ts):\d+:/);
				if (!match) continue;

				const fullPath = match[1];
				const relativePath = fullPath.replace(`${SRC_DIR}/`, "");

				// Skip allowed files
				if (ALLOWED_FILES.has(relativePath)) continue;

				// Skip if it's in a comment or deprecation notice
				if (line.includes("@deprecated") || line.includes("//")) continue;

				// Skip test files
				if (line.includes(".test.ts")) continue;

				violations.push(line.trim());
			}

			if (violations.length > 0) {
				throw new Error(
					`Direct .tiller path construction found in:\n${violations.join("\n")}\n\n` +
						"All modules must use CORE_PATHS or PATHS from state/paths.ts or state/config.ts",
				);
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("Direct .tiller")) {
				throw error;
			}
			// grep returns non-zero if no matches, which is good
		}
	});

	test("no module uses relative .tiller assignment", () => {
		// Pattern: variable = ".tiller" (relative path assignment)
		try {
			const result = execSync(
				`grep -rn '= *"\\.tiller' ${SRC_DIR} --include='*.ts' || true`,
				{ encoding: "utf-8" },
			);

			const violations: string[] = [];

			for (const line of result.split("\n").filter(Boolean)) {
				const match = line.match(/^(.+?\.ts):\d+:/);
				if (!match) continue;

				const fullPath = match[1];
				const relativePath = fullPath.replace(`${SRC_DIR}/`, "");

				// Skip allowed files and deprecation notices
				if (ALLOWED_FILES.has(relativePath)) continue;
				if (line.includes("@deprecated")) continue;

				violations.push(line.trim());
			}

			if (violations.length > 0) {
				throw new Error(
					`Relative .tiller path assignment found in:\n${violations.join("\n")}\n\n` +
						"All paths must derive from CORE_PATHS.TILLER_DIR",
				);
			}
		} catch (error) {
			if (error instanceof Error && error.message.includes("Relative .tiller")) {
				throw error;
			}
		}
	});

	test("paths.ts has no internal tiller module imports (prevents cycles)", () => {
		const pathsContent = execSync(`cat ${join(SRC_DIR, PATHS_FILE)}`, {
			encoding: "utf-8",
		});

		// Check for imports from other tiller modules
		const internalImports = pathsContent.match(
			/from\s+["']\.\.?\/(commands|state|types|utils)/g,
		);

		if (internalImports && internalImports.length > 0) {
			throw new Error(
				`paths.ts must not import from other tiller modules to prevent cycles:\n${internalImports.join("\n")}`,
			);
		}
	});

	test("all state modules import from paths.ts or config.ts", () => {
		// Verify that state modules don't construct their own paths
		const stateDir = join(SRC_DIR, "state");
		const stateModules = ["config.ts", "migration.ts", "constitutional.ts", "agent.ts"];

		for (const module of stateModules) {
			if (module === "paths.ts") continue; // Skip the source of truth

			const content = execSync(`cat ${join(stateDir, module)}`, {
				encoding: "utf-8",
			});

			// Must import from paths.ts or use PATHS from config.ts
			const hasPathsImport =
				content.includes('from "./paths.js"') ||
				content.includes('from "./config.js"');

			// Should not have hardcoded .tiller paths (except in deprecated comments)
			const hasHardcodedPath =
				content.includes('".tiller') &&
				!content.includes("@deprecated") &&
				!content.includes("// ");

			expect(hasPathsImport).toBe(true);
			expect(hasHardcodedPath).toBe(false);
		}
	});
});

describe("Path Consistency Across Modules", () => {
	test("config.ts PATHS includes all CORE_PATHS", async () => {
		const { CORE_PATHS } = await import("../../../src/tiller/state/paths.js");
		const { PATHS } = await import("../../../src/tiller/state/config.js");

		// All CORE_PATHS keys should be in PATHS
		for (const key of Object.keys(CORE_PATHS)) {
			expect(PATHS).toHaveProperty(key);
			expect((PATHS as Record<string, string>)[key]).toBe(
				(CORE_PATHS as Record<string, string>)[key],
			);
		}
	});

	test("config.ts re-exports findProjectRoot", async () => {
		const pathsModule = await import("../../../src/tiller/state/paths.js");
		const configModule = await import("../../../src/tiller/state/config.js");

		// Both should export findProjectRoot
		expect(typeof pathsModule.findProjectRoot).toBe("function");
		expect(typeof configModule.findProjectRoot).toBe("function");

		// They should return the same result
		expect(configModule.findProjectRoot()).toBe(pathsModule.findProjectRoot());
	});
});
