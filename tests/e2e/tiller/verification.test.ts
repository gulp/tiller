/**
 * E2E tests for Tiller verification commands (verify, uat, fix)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	cleanupTestEnv,
	createMockPlan,
	createMockSummary,
	createMockTrack,
	createTestEnv,
	runTiller,
} from "../helpers";

describe("tiller verify command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("runs automated checks from PLAN.md verification section with --auto", async () => {
		const planPath = ".planning/phases/test/verify-01-PLAN.md";
		const planContent = `---
phase: test
plan: 01
type: execute
---

<objective>Test feature</objective>

<verification>
- [ ] \`echo "test passed"\`
</verification>
`;
		createMockPlan(testDir, planPath, planContent);
		createMockTrack(testDir, "track-verify1", "active/executing", { planPath });

		const result = await runTiller(["verify", "track-verify1", "--auto"], {
			cwd: testDir,
		});

		// Should find and run the verification check
		// Output format: "Verification: 1/1 checks passed"
		expect(result.stdout).toContain("checks passed");
	});

	it("fails when no verification section in PLAN.md with --auto", async () => {
		const planPath = ".planning/phases/test/verify-02-PLAN.md";
		const planContent = `---
phase: test
plan: 02
type: execute
---

<objective>Test feature without verification</objective>
`;
		createMockPlan(testDir, planPath, planContent);
		createMockTrack(testDir, "track-verify2", "active/executing", { planPath });

		const result = await runTiller(["verify", "track-verify2", "--auto"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("No <verification>");
	});

	it("--auto --dry-run shows checks without running them", async () => {
		const planPath = ".planning/phases/test/verify-03-PLAN.md";
		const planContent = `---
phase: test
plan: 03
type: execute
---

<objective>Test feature</objective>

<verification>
- [ ] \`echo "check 1"\`
- [ ] \`echo "check 2"\`
</verification>
`;
		createMockPlan(testDir, planPath, planContent);
		createMockTrack(testDir, "track-verify3", "active/executing", { planPath });

		const result = await runTiller(
			["verify", "track-verify3", "--auto", "--dry-run"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("dry run");
		// Output shows checks to be run
		expect(result.stdout).toContain("echo");
	});

	it("fails for non-existent run", async () => {
		const result = await runTiller(["verify", "nonexistent-track"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		// Error may go to stdout via outputError TOON
		expect(result.stdout + result.stderr).toContain("No run or plan found");
	});

	it("requires track to be in active or verifying state", async () => {
		const planPath = ".planning/phases/test/verify-04-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-verify4", "proposed", { planPath });

		const result = await runTiller(["verify", "track-verify4"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("active or verifying");
	});
});

describe("tiller uat command", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("outputs JSON checklist by default", async () => {
		const planPath = ".planning/phases/test/uat-01-PLAN.md";
		const summaryPath = ".planning/phases/test/uat-01-SUMMARY.md";

		createMockPlan(testDir, planPath);
		createMockSummary(testDir, summaryPath);
		createMockTrack(testDir, "track-uat1", "verifying/testing", { planPath });

		const result = await runTiller(["uat", "track-uat1"], { cwd: testDir });

		// Should output JSON checklist
		expect(result.exitCode).toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output).toHaveProperty("run_id");
		expect(output.run_id).toBe("track-uat1");
	});

	it("fails when no SUMMARY.md found", async () => {
		const planPath = ".planning/phases/test/uat-02-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-uat2", "verifying/testing", { planPath });
		// No SUMMARY.md created

		const result = await runTiller(["uat", "track-uat2"], { cwd: testDir });

		expect(result.exitCode).not.toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.code).toBe("NO_SUMMARY");
	});

	it("fails for track not in active/verifying state", async () => {
		const planPath = ".planning/phases/test/uat-03-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-uat3", "proposed", { planPath });

		const result = await runTiller(["uat", "track-uat3"], { cwd: testDir });

		expect(result.exitCode).not.toBe(0);
		const output = JSON.parse(result.stdout);
		expect(output.code).toBe("INVALID_STATE");
	});

	it("fails for non-existent run", async () => {
		const result = await runTiller(["uat", "nonexistent-track"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		const output = JSON.parse(result.stdout);
		// Terminology changed: track → run
		expect(output.code).toBe("NO_RUN");
	});
});

describe("tiller verify --pass/--fail", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("--pass transitions from verifying/testing to verifying/passed", async () => {
		const planPath = ".planning/phases/test/pass-01-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-pass1", "verifying/testing", { planPath });

		const result = await runTiller(["verify", "track-pass1", "--pass"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("verification passed");
		expect(result.stdout).toContain("verifying/passed");
	});

	it("--pass requires run to be in active/* or verifying/* state", async () => {
		// Note: verify --pass now works from both active/* and verifying/* states
		// This test checks that it fails from states like 'proposed'
		const planPath = ".planning/phases/test/pass-02-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-pass2", "proposed", { planPath });

		const result = await runTiller(["verify", "track-pass2", "--pass"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("active or verifying");
	});

	it("--fail requires --issue description", async () => {
		const planPath = ".planning/phases/test/fail-01-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-fail1", "verifying/testing", { planPath });

		const result = await runTiller(["verify", "track-fail1", "--fail"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Issue description required");
		expect(result.stderr).toContain("--issue");
	});

	it("--fail --issue transitions to verifying/failed and records issue", async () => {
		const planPath = ".planning/phases/test/fail-02-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-fail2", "verifying/testing", { planPath });

		const result = await runTiller(
			["verify", "track-fail2", "--fail", "--issue", "Button not working"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("verification failed");
		expect(result.stdout).toContain("verifying/failed");
		expect(result.stdout).toContain("UAT-001");
		expect(result.stdout).toContain("Button not working");
	});

	it("--fail requires run to be in active/* or verifying/* state", async () => {
		// Note: verify --fail now works from both active/* and verifying/* states
		// This test checks that it fails from states like 'proposed'
		const planPath = ".planning/phases/test/fail-03-PLAN.md";
		createMockPlan(testDir, planPath);
		createMockTrack(testDir, "track-fail3", "proposed", { planPath });

		const result = await runTiller(
			["verify", "track-fail3", "--fail", "--issue", "Test"],
			{ cwd: testDir },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("active or verifying");
	});
});

// Note: tiller fix command tests removed - command was removed from CLI
// Tests will be re-added when command is re-implemented

describe("tiller complete verification gating", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("blocks completion from verifying/testing without --skip-verify", async () => {
		const planPath = ".planning/phases/test/complete-01-PLAN.md";
		const summaryPath = ".planning/phases/test/complete-01-SUMMARY.md";
		createMockPlan(testDir, planPath);
		createMockSummary(testDir, summaryPath);
		createMockTrack(testDir, "track-comp1", "verifying/testing", { planPath });

		const result = await runTiller(["complete", "track-comp1"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		// Error is TOON format on stdout, not plain text on stderr
		expect(result.stdout).toContain("error:");
		expect(result.stdout).toContain("Verification in progress");
	});

	it("blocks completion from verifying/failed without --skip-verify", async () => {
		const planPath = ".planning/phases/test/complete-02-PLAN.md";
		const summaryPath = ".planning/phases/test/complete-02-SUMMARY.md";
		createMockPlan(testDir, planPath);
		createMockSummary(testDir, summaryPath);
		createMockTrack(testDir, "track-comp2", "verifying/failed", { planPath });

		const result = await runTiller(["complete", "track-comp2"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		// Error is TOON format on stdout
		expect(result.stdout).toContain("error:");
		expect(result.stdout).toContain("Verification failed");
		expect(result.stdout).toContain("tiller fix");
	});

	it("allows completion from verifying/passed", async () => {
		const planPath = ".planning/phases/test/complete-03-PLAN.md";
		// verifying/passed → complete requires SUMMARY.done.md (finalized), not SUMMARY.md (draft)
		const summaryPath = ".planning/phases/test/complete-03-SUMMARY.done.md";
		createMockPlan(testDir, planPath);
		createMockSummary(testDir, summaryPath);
		createMockTrack(testDir, "track-comp3", "verifying/passed", { planPath });

		const result = await runTiller(["complete", "track-comp3"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("completed");
	});

	it("--skip-verify bypasses verification gate", async () => {
		const planPath = ".planning/phases/test/complete-04-PLAN.md";
		const summaryPath = ".planning/phases/test/complete-04-SUMMARY.md";
		createMockPlan(testDir, planPath);
		createMockSummary(testDir, summaryPath);
		createMockTrack(testDir, "track-comp4", "verifying/testing", { planPath });

		const result = await runTiller(
			["complete", "track-comp4", "--skip-verify"],
			{ cwd: testDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("completed");
		expect(result.stdout).toContain("Warning");
	});

	it("blocks completion from active/* without --skip-verify", async () => {
		const planPath = ".planning/phases/test/complete-05-PLAN.md";
		const summaryPath = ".planning/phases/test/complete-05-SUMMARY.md";
		createMockPlan(testDir, planPath);
		createMockSummary(testDir, summaryPath);
		createMockTrack(testDir, "track-comp5", "active/executing", { planPath });

		const result = await runTiller(["complete", "track-comp5"], {
			cwd: testDir,
		});

		expect(result.exitCode).not.toBe(0);
		// Error is TOON format on stdout
		expect(result.stdout).toContain("error:");
		expect(result.stdout).toContain("Verification not started");
	});
});

describe("checkbox format verification gate", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await createTestEnv();
	});

	afterEach(async () => {
		await cleanupTestEnv(testDir);
	});

	it("--pass on checkbox format shows warning for pending cmd checks", async () => {
		const planPath = ".planning/phases/test/checkbox-01-PLAN.md";
		const planContent = `---
title: "Test checkbox format"
phase: test
plan: 01
type: execute
---

<objective>Test checkbox verification</objective>

<verification>
- [ ] \`echo test\` passes
- [ ] \`echo second\` also passes
</verification>
`;
		createMockPlan(testDir, planPath, planContent);
		createMockTrack(testDir, "track-checkbox1", "active/executing", {
			planPath,
		});

		const result = await runTiller(["verify", "track-checkbox1", "--pass"], {
			cwd: testDir,
		});

		// Should succeed but show warning about cmd checks
		// Warning may go to stdout or stderr depending on console.error handling
		expect(result.exitCode).toBe(0);
		const allOutput = result.stdout + result.stderr;
		expect(allOutput).toContain("Cmd checks not executed");
	});

	it("--pass on checkbox format updates PLAN.md checkboxes to [x]", async () => {
		const planPath = ".planning/phases/test/checkbox-02-PLAN.md";
		// Use simple command without quotes to avoid escaping issues
		const planContent = `---
title: "Test checkbox update"
phase: test
plan: 02
type: execute
---

<objective>Test checkbox update on pass</objective>

<verification>
- [ ] \`tsc --noEmit\` passes
</verification>
`;
		createMockPlan(testDir, planPath, planContent);
		createMockTrack(testDir, "track-checkbox2", "active/executing", {
			planPath,
		});

		const result = await runTiller(["verify", "track-checkbox2", "--pass"], {
			cwd: testDir,
		});

		expect(result.exitCode).toBe(0);

		// Read the updated plan file
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const updatedContent = readFileSync(
			join(testDir, planPath),
			"utf-8",
		);

		// Checkboxes should be updated to [x]
		expect(updatedContent).toContain("- [x]");
	});

	it("--auto on checkbox format executes cmd checks", async () => {
		const planPath = ".planning/phases/test/checkbox-03-PLAN.md";
		const planContent = `---
title: "Test checkbox auto"
phase: test
plan: 03
type: execute
---

<objective>Test checkbox with --auto</objective>

<verification>
- [ ] \`echo "checkbox test"\` passes
</verification>
`;
		createMockPlan(testDir, planPath, planContent);
		createMockTrack(testDir, "track-checkbox3", "active/executing", {
			planPath,
		});

		const result = await runTiller(["verify", "track-checkbox3", "--auto"], {
			cwd: testDir,
		});

		// Should run the echo command and pass
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("checks passed");
	});
});
