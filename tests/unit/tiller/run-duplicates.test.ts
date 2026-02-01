/**
 * Unit tests for duplicate run prevention
 *
 * Tests that getRunByPlanPath() normalizes paths to prevent duplicates
 * when the same plan is referenced with absolute vs relative paths.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	createRun,
	getRunByPlanPath,
	saveRun,
} from "../../../src/tiller/state/run.js";
import type { Run } from "../../../src/tiller/types/index.js";

// Test directory setup
const TEST_ROOT = process.cwd();
const TILLER_DIR = join(TEST_ROOT, ".tiller");
const RUNS_DIR = join(TILLER_DIR, "runs");

beforeAll(() => {
	// Create .tiller/runs directory
	if (!existsSync(RUNS_DIR)) {
		mkdirSync(RUNS_DIR, { recursive: true });
	}
});

afterAll(() => {
	// Clean up test runs
	if (existsSync(TILLER_DIR)) {
		rmSync(TILLER_DIR, { recursive: true, force: true });
	}
});

describe("getRunByPlanPath", () => {
	test("finds run with exact path match", () => {
		const planPath = "plans/test/test-01-PLAN.md";
		const run = createRun(planPath, "Test intent");

		const found = getRunByPlanPath(planPath);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(run.id);
	});

	test("finds run when querying with absolute path", () => {
		const relativePath = "plans/test/test-02-PLAN.md";
		const absolutePath = join(TEST_ROOT, relativePath);

		// Create with relative path
		const run = createRun(relativePath, "Test intent");

		// Query with absolute path - should find it
		const found = getRunByPlanPath(absolutePath);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(run.id);
	});

	test("finds run when querying with relative path", () => {
		const relativePath = "plans/test/test-03-PLAN.md";
		const absolutePath = join(TEST_ROOT, relativePath);

		// Create with absolute path
		const run: Run = {
			id: "run-abs-test",
			initiative: "test",
			intent: "Test absolute path",
			state: "ready",
			plan_path: absolutePath,
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
		};
		saveRun(run);

		// Query with relative path - should find it
		const found = getRunByPlanPath(relativePath);
		expect(found).not.toBeNull();
		expect(found?.id).toBe(run.id);
	});

	test("createRun is idempotent with path normalization", () => {
		const relativePath = "plans/test/test-04-PLAN.md";
		const absolutePath = join(TEST_ROOT, relativePath);

		// Create with relative path
		const run1 = createRun(relativePath, "Test intent");

		// Try to create again with absolute path - should return same run
		const run2 = createRun(absolutePath, "Different intent");

		expect(run2.id).toBe(run1.id);
		expect(run2.intent).toBe(run1.intent); // Should keep original intent
	});

	test("returns null for non-existent plan", () => {
		const found = getRunByPlanPath("plans/nonexistent/plan.md");
		expect(found).toBeNull();
	});
});
