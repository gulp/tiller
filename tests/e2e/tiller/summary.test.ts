/**
 * E2E tests for Tiller summary commands (query, drift, show, generate)
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockSummary,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller summary query command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("extracts objective from SUMMARY.md", async () => {
		const summaryPath = ".planning/phases/test/query-01-SUMMARY.md";
		const summaryContent = `---
phase: test
plan: 01
---

# Test Summary

## Objective

This is the test objective for summary query.

## Deliverables

- \`src/test.ts\`
`;
		createMockSummary(testDir, summaryPath, summaryContent);

		const result = await runTiller(
			["summary", "query", summaryPath, "objective"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("test objective");
	});

	it("extracts deliverables from SUMMARY.md", async () => {
		const summaryPath = ".planning/phases/test/query-02-SUMMARY.md";
		const summaryContent = `---
phase: test
plan: 02
---

# Test Summary

## Deliverables

- \`src/feature.ts\`
- \`src/utils.ts\`
- \`tests/feature.test.ts\`
`;
		createMockSummary(testDir, summaryPath, summaryContent);

		const result = await runTiller(
			["summary", "query", summaryPath, "deliverables", "--json"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		const deliverables = JSON.parse(result.stdout);
		expect(deliverables).toContain("src/feature.ts");
		expect(deliverables).toContain("src/utils.ts");
	});

	it("fails for non-existent file", async () => {
		const result = await runTiller(
			["summary", "query", "nonexistent.md", "objective"],
			{ cwd: testDir },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not found");
	});

	it("fails for invalid query type", async () => {
		const summaryPath = ".planning/phases/test/query-03-SUMMARY.md";
		createMockSummary(testDir, summaryPath);

		const result = await runTiller(
			["summary", "query", summaryPath, "invalid-type"],
			{ cwd: testDir },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Invalid query type");
	});
});

describe("tiller summary drift command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("detects template/schema files", async () => {
		const summaryPath = ".planning/phases/test/drift-01-SCHEMA-SUMMARY.md";
		const schemaContent = `---
phase: <phase>
plan: <plan>
---

# Summary Schema

## Deliverables

- \`<filepath>\`
`;
		createMockSummary(testDir, summaryPath, schemaContent);

		const result = await runTiller(["summary", "drift", summaryPath], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("template");
	});

	it("detects drift when deliverables are missing", async () => {
		const summaryPath = ".planning/phases/test/drift-02-SUMMARY.md";
		const summaryContent = `---
phase: test
plan: 02
---

# Test Summary

## Deliverables

- \`nonexistent/missing-file.ts\`
`;
		createMockSummary(testDir, summaryPath, summaryContent);

		const result = await runTiller(
			["summary", "drift", summaryPath, "--force"],
			{ cwd: testDir },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("DRIFT DETECTED");
		expect(result.stdout).toContain("MISSING");
	});

	it("passes when deliverables exist", async () => {
		const summaryPath = ".planning/phases/test/drift-03-SUMMARY.md";
		const summaryContent = `---
phase: test
plan: 03
---

# Test Summary

## Deliverables

- \`package.json\`
`;
		createMockSummary(testDir, summaryPath, summaryContent);

		// package.json exists at the test env root
		writeFileSync(join(testDir, "package.json"), "{}");

		const result = await runTiller(
			["summary", "drift", summaryPath, "--force"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No drift");
	});

	it("outputs JSON with --json flag", async () => {
		const summaryPath = ".planning/phases/test/drift-04-SUMMARY.md";
		// Create a non-template summary that won't trigger drift detection
		const summaryContent = `---
phase: test
plan: 04
---

# Test Summary

## Objective

Test drift JSON output.

## Deliverables

- \`package.json\`
`;
		createMockSummary(testDir, summaryPath, summaryContent);
		// Create the deliverable file so no drift detected
		writeFileSync(join(testDir, "package.json"), "{}");

		const result = await runTiller(
			["summary", "drift", summaryPath, "--json"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json).toHaveProperty("file");
		expect(json).toHaveProperty("drift");
	});

	it("fails for non-existent file", async () => {
		const result = await runTiller(["summary", "drift", "nonexistent.md"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not found");
	});
});

describe("tiller summary show command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("displays formatted SUMMARY.md content", async () => {
		const summaryPath = ".planning/phases/test/show-01-SUMMARY.md";
		const summaryContent = `---
phase: test
plan: 01
epic_id: test-epic-001
completed: 2026-01-15
---

# Test Summary

## Objective

This is the test objective.

## Tasks

1. First task - done
2. Second task - in progress
`;
		createMockSummary(testDir, summaryPath, summaryContent);

		const result = await runTiller(["summary", "show", summaryPath], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Test Summary");
		expect(result.stdout).toContain("OBJECTIVE");
		expect(result.stdout).toContain("TASKS");
	});

	it("outputs JSON with --json flag", async () => {
		const summaryPath = ".planning/phases/test/show-02-SUMMARY.md";
		createMockSummary(testDir, summaryPath);

		const result = await runTiller(["summary", "show", summaryPath, "--json"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json).toHaveProperty("file");
		expect(json).toHaveProperty("frontmatter");
		expect(json).toHaveProperty("objective");
	});

	it("fails for non-existent file", async () => {
		const result = await runTiller(["summary", "show", "nonexistent.md"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not found");
	});
});

describe("tiller summary generate command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("generates SUMMARY.md from track data with --dry-run", async () => {
		const planPath = ".planning/phases/test/gen-01-PLAN.md";
		const planContent = `---
title: Test Feature Summary
phase: test
plan: 01
type: execute
---

<objective>
Test feature for summary generation.
</objective>
`;
		createMockPlan(testDir, planPath, planContent);
		createMockTrack(testDir, "track-gen1", "active/executing", { planPath });

		const result = await runTiller(
			["summary", "generate", "track-gen1", "--dry-run"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("DRY RUN");
		expect(result.stdout).toContain("Summary");
		expect(result.stdout).toContain("Objective");
	});

	it("outputs JSON with --json flag", async () => {
		const planPath = ".planning/phases/test/gen-02-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-gen2", "active/executing", { planPath });

		const result = await runTiller(
			["summary", "generate", "track-gen2", "--json"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json).toHaveProperty("frontmatter");
		expect(json).toHaveProperty("objective");
		expect(json).toHaveProperty("deliverables");
	});

	it("fails for non-existent track", async () => {
		const result = await runTiller(
			["summary", "generate", "nonexistent-track"],
			{ cwd: testDir },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("not found");
	});

	it("fails when SUMMARY.md already exists (without --force)", async () => {
		const planPath = ".planning/phases/test/gen-03-PLAN.md";
		const summaryPath = ".planning/phases/test/gen-03-SUMMARY.md";

		createMockPlan(testDir, planPath);
		createMockSummary(testDir, summaryPath); // Create existing SUMMARY.md
		createMockTrack(testDir, "track-gen3", "active/executing", { planPath });

		const result = await runTiller(["summary", "generate", "track-gen3"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("already exists");
	});
});
