/**
 * Global test setup for Tiller E2E tests
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Path to the built tiller CLI */
export const CLI_PATH = resolve(__dirname, "../../dist/tiller/index.js");

/** Path to the project root */
export const PROJECT_ROOT = resolve(__dirname, "../..");

/**
 * Create an isolated test directory with optional initial structure
 */
export function createTestDirectory(prefix = "tiller-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Clean up a test directory
 */
export function cleanupTestDirectory(dir: string): void {
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Setup a test directory with .planning structure for tiller tests
 */
export function setupTillerTestEnv(baseDir: string): void {
	const planningDir = join(baseDir, ".planning");
	mkdirSync(planningDir, { recursive: true });
}

/**
 * Create a full tiller test environment with .tiller directory structure
 */
export async function createTestEnv(): Promise<string> {
	const testDir = createTestDirectory();

	// Create .tiller directory structure
	const tillerDir = join(testDir, ".tiller");
	const runsDir = join(tillerDir, "runs");

	mkdirSync(tillerDir, { recursive: true });
	mkdirSync(runsDir, { recursive: true });

	// Create tiller.toml directly (avoids config.json migration)
	// Set working_initiative = "test" to satisfy hasExplicitFocus() checks
	// and create plans in .planning/phases/test/ structure
	const tomlConfig = `version = "0.2.0"

[paths]
plans = ".planning/phases"
specs = "specs"

[sync]
auto_sync_on_status = false

[workflow]
confirmation_prompts = false
working_initiative = "test"
`;
	writeFileSync(join(tillerDir, "tiller.toml"), tomlConfig);

	// Create events.jsonl (empty)
	writeFileSync(join(tillerDir, "events.jsonl"), "");

	// Create PRIME.md with test-friendly defaults
	// require-summary: false allows completion without SUMMARY verification
	writeFileSync(
		join(tillerDir, "PRIME.md"),
		`# Tiller Test Config
require-summary: false
confirm-mode: false
`,
	);

	// Create .planning directory
	const planningDir = join(testDir, ".planning");
	mkdirSync(planningDir, { recursive: true });

	return testDir;
}

/**
 * Clean up test environment
 */
export async function cleanupTestEnv(testDir: string): Promise<void> {
	cleanupTestDirectory(testDir);
}

/**
 * Create a mock run file for testing
 */
export function createMockRun(
	testDir: string,
	runId: string,
	state: string,
	options: {
		intent?: string;
		planPath?: string;
		initiative?: string | null;
		filesTouched?: string[];
		claimedBy?: string | null;
		claimExpires?: string | null;
	} = {},
): void {
	const runsDir = join(testDir, ".tiller", "runs");
	const now = new Date().toISOString();

	const run = {
		id: runId,
		initiative: options.initiative ?? null,
		intent: options.intent ?? `Test run ${runId}`,
		state,
		plan_path: options.planPath ?? `.planning/phases/test/${runId}-PLAN.md`,
		created: now,
		updated: now,
		transitions: [],
		checkpoints: [],
		beads_epic_id: null,
		beads_task_id: null,
		beads_snapshot: null,
		claimed_by: options.claimedBy ?? null,
		claimed_at: options.claimedBy ? now : null,
		claim_expires: options.claimExpires ?? null,
		files_touched: options.filesTouched ?? [],
		priority: 99,
		depends_on: [],
	};

	writeFileSync(
		join(runsDir, `${runId}.json`),
		JSON.stringify(run, null, 2),
	);
}

// Legacy alias for backward compatibility in tests
export const createMockTrack = createMockRun;

/**
 * Create a mock PLAN.md file for testing
 */
export function createMockPlan(
	testDir: string,
	planPath: string,
	content?: string,
): void {
	const fullPath = join(testDir, planPath);
	const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));

	mkdirSync(dir, { recursive: true });

	const defaultContent = `---
title: Test Plan
phase: test
plan: 01
type: execute
---

# Test Plan

Test plan content.
`;

	writeFileSync(fullPath, content ?? defaultContent);
}

/**
 * Create a mock SUMMARY.md file for testing
 */
export function createMockSummary(
	testDir: string,
	summaryPath: string,
	content?: string,
): void {
	const fullPath = join(testDir, summaryPath);
	const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));

	mkdirSync(dir, { recursive: true });

	// Complete summary with all required sections for doctor checks
	// Note: Avoid placeholder-like hashes (abc, def, 123, 000) as they trigger template detection
	// Deliverables must have backticked paths, verification must use ✓/✗ not [x]
	const defaultContent = `---
title: Test Summary
phase: test
plan: 01
completed: 2026-01-15
---

# Test Summary

**Test objective summary**

## Objective

Test objective description

## Deliverables

- \`src/test.ts\` - Test file created

## Tasks

1. **Task 1: Test task** - Completed

## Verification

- ✓ Build passes
- ✓ Tests pass

## Commits

- f7e8d92 - Initial commit
`;

	writeFileSync(fullPath, content ?? defaultContent);
}
