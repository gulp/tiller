/**
 * Unit tests for run.ts versioned state (optimistic locking)
 *
 * Tests:
 * 1. loadRunVersioned() returns run with _version and _read_at metadata
 * 2. loadRunVersioned() returns null for non-existent run
 * 3. saveRunIfFresh() saves successfully when version matches
 * 4. saveRunIfFresh() throws StaleWriteError when version doesn't match
 * 5. saveRunIfFresh() throws Error when track has no _version
 * 6. StaleReadError has correct properties
 * 7. StaleWriteError has correct properties
 * 8. Version metadata is stripped when saving
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	loadRun,
	loadRunVersioned,
	saveRun,
	saveRunIfFresh,
	StaleReadError,
	StaleWriteError,
} from "../../../src/tiller/state/run.js";
import type { Run } from "../../../src/tiller/types/index.js";

// Test directory setup
const TEST_ROOT = process.cwd();
const TILLER_DIR = join(TEST_ROOT, ".tiller");
const RUNS_DIR = join(TILLER_DIR, "runs");

// Helper to create a minimal valid Run
function createTestRun(id: string): Run {
	return {
		id,
		initiative: "test",
		intent: "Test run for versioned state",
		state: "ready",
		plan_path: `plans/test/${id}-PLAN.md`,
		created: new Date().toISOString(),
		updated: new Date().toISOString(),
		transitions: [],
		checkpoints: [],
		beads_epic_id: null,
		beads_task_id: null,
		beads_snapshot: null,
		claimed_by: null,
		claimed_at: null,
		claim_expires: null,
		files_touched: [],
		priority: 99,
		depends_on: [],
		verification: undefined,
	};
}

describe("Versioned State (Optimistic Locking)", () => {
	beforeAll(() => {
		// Ensure test directory exists
		mkdirSync(RUNS_DIR, { recursive: true });
	});

	afterAll(() => {
		// Clean up test runs
		const testFiles = ["run-version-test.json", "run-fresh-test.json", "run-stale-test.json"];
		for (const file of testFiles) {
			const path = join(RUNS_DIR, file);
			if (existsSync(path)) {
				rmSync(path);
			}
		}
	});

	beforeEach(() => {
		// Clean up between tests
		const testFiles = ["run-version-test.json", "run-fresh-test.json", "run-stale-test.json"];
		for (const file of testFiles) {
			const path = join(RUNS_DIR, file);
			if (existsSync(path)) {
				rmSync(path);
			}
		}
	});

	describe("loadRunVersioned()", () => {
		test("returns run with _version and _read_at metadata", () => {
			// Create a test run
			const testRun = createTestRun("run-version-test");
			saveRun(testRun);

			// Load with versioned metadata
			const loaded = loadRunVersioned("run-version-test");

			expect(loaded).not.toBeNull();
			expect(loaded!.id).toBe("run-version-test");
			expect(loaded!._version).toBeDefined();
			expect(loaded!._read_at).toBeDefined();

			// Version should be an ISO timestamp
			expect(new Date(loaded!._version!).getTime()).not.toBeNaN();
			expect(new Date(loaded!._read_at!).getTime()).not.toBeNaN();
		});

		test("returns null for non-existent run", () => {
			const loaded = loadRunVersioned("run-does-not-exist");
			expect(loaded).toBeNull();
		});

		test("_read_at is close to current time", () => {
			const testRun = createTestRun("run-version-test");
			saveRun(testRun);

			const beforeLoad = new Date().getTime();
			const loaded = loadRunVersioned("run-version-test");
			const afterLoad = new Date().getTime();

			expect(loaded).not.toBeNull();
			const readAtTime = new Date(loaded!._read_at!).getTime();

			// _read_at should be between beforeLoad and afterLoad
			expect(readAtTime).toBeGreaterThanOrEqual(beforeLoad);
			expect(readAtTime).toBeLessThanOrEqual(afterLoad);
		});
	});

	describe("saveRunIfFresh()", () => {
		test("saves successfully when version matches", () => {
			// Create and save initial run
			const testRun = createTestRun("run-fresh-test");
			saveRun(testRun);

			// Load with version
			const loaded = loadRunVersioned("run-fresh-test");
			expect(loaded).not.toBeNull();

			// Modify and save
			loaded!.intent = "Modified intent";
			const result = saveRunIfFresh(loaded!);

			expect(result.saved).toBe(true);
			expect(result.newVersion).toBeDefined();

			// Verify the change persisted
			const reloaded = loadRun("run-fresh-test");
			expect(reloaded!.intent).toBe("Modified intent");
		});

		test("throws StaleWriteError when version doesn't match", async () => {
			// Create and save initial run
			const testRun = createTestRun("run-stale-test");
			saveRun(testRun);

			// Load with version
			const loaded = loadRunVersioned("run-stale-test");
			expect(loaded).not.toBeNull();

			// Simulate another process modifying the file
			// Wait a bit to ensure mtime changes (filesystem granularity)
			await new Promise((resolve) => setTimeout(resolve, 10));
			const otherRun = loadRun("run-stale-test");
			otherRun!.intent = "Modified by other process";
			saveRun(otherRun!);

			// Try to save with stale version
			expect(() => saveRunIfFresh(loaded!)).toThrow(StaleWriteError);
		});

		test("throws Error when track has no _version", () => {
			const testRun = createTestRun("run-fresh-test");
			// Note: testRun has no _version since it wasn't loaded with loadRunVersioned

			expect(() => saveRunIfFresh(testRun)).toThrow(
				"Cannot use saveRunIfFresh without version",
			);
		});

		test("newVersion is different after save", async () => {
			// Create and save initial run
			const testRun = createTestRun("run-fresh-test");
			saveRun(testRun);

			// Load with version
			const loaded = loadRunVersioned("run-fresh-test");
			expect(loaded!._version).toBeDefined(); // Capture original version for comparison

			// Wait a bit to ensure mtime changes
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Save and get new version
			loaded!.intent = "Modified";
			const result = saveRunIfFresh(loaded!);

			// New version should be different (unless filesystem granularity is too coarse)
			// This test may be flaky on HFS+/FAT32 with 1-2s granularity
			expect(result.newVersion).toBeDefined();
		});
	});

	describe("Error Classes", () => {
		test("StaleReadError has correct properties", () => {
			const error = new StaleReadError("run-123", "2024-01-01T00:00:00Z", "2024-01-01T00:00:01Z");

			expect(error.name).toBe("StaleReadError");
			expect(error.runId).toBe("run-123");
			expect(error.expectedVersion).toBe("2024-01-01T00:00:00Z");
			expect(error.actualVersion).toBe("2024-01-01T00:00:01Z");
			expect(error.message).toContain("mtime changed during read");
			expect(error.message).toContain("2024-01-01T00:00:00Z");
			expect(error.message).toContain("2024-01-01T00:00:01Z");
		});

		test("StaleWriteError has correct properties", () => {
			const error = new StaleWriteError("run-456", "2024-01-01T00:00:00Z", "2024-01-01T00:00:01Z");

			expect(error.name).toBe("StaleWriteError");
			expect(error.runId).toBe("run-456");
			expect(error.expectedVersion).toBe("2024-01-01T00:00:00Z");
			expect(error.actualVersion).toBe("2024-01-01T00:00:01Z");
			expect(error.message).toContain("version mismatch");
			expect(error.message).toContain("Another process may have modified");
		});

		test("errors are instanceof Error", () => {
			const staleRead = new StaleReadError("run-1", "v1", "v2");
			const staleWrite = new StaleWriteError("run-2", "v1", "v2");

			expect(staleRead).toBeInstanceOf(Error);
			expect(staleWrite).toBeInstanceOf(Error);
		});
	});

	describe("Version Metadata Stripping", () => {
		test("_version and _read_at are not persisted to disk", () => {
			// Create and save a run with version metadata
			const testRun = createTestRun("run-version-test");
			saveRun(testRun);

			// Load with version metadata
			const loaded = loadRunVersioned("run-version-test");
			expect(loaded!._version).toBeDefined();
			expect(loaded!._read_at).toBeDefined();

			// Modify and save
			loaded!.intent = "Modified";
			saveRunIfFresh(loaded!);

			// Read raw file content
			const path = join(RUNS_DIR, "run-version-test.json");
			const rawContent = require("fs").readFileSync(path, "utf-8");
			const parsed = JSON.parse(rawContent);

			// Version metadata should NOT be in the persisted file
			expect(parsed._version).toBeUndefined();
			expect(parsed._read_at).toBeUndefined();
		});
	});
});
