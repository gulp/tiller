/**
 * Tests for UAT issue extraction and fix plan generation
 */

import { describe, expect, test } from "vitest";
import type {
	Track,
	VerificationCheck,
	VerificationResults,
} from "../../../src/tiller/types/index.js";
import {
	extractUATIssues,
	generateFixPlanContent,
	generateFixTasks,
	getFixPlanPath,
	type UATIssue,
} from "../../../src/tiller/verification/fix.js";

// Helper to create a check with required fields
function createCheck(overrides: Partial<VerificationCheck>): VerificationCheck {
	return {
		name: "Test Check",
		command: "test-cmd",
		status: "pass",
		ran_at: new Date().toISOString(),
		...overrides,
	};
}

// Helper to create UAT verification results
function createUAT(checks: VerificationCheck[]): VerificationResults {
	const failed = checks.filter((c) => c.status === "fail").length;
	return {
		uat: {
			checks,
			status: failed > 0 ? "fail" : "pass",
			ran_at: new Date().toISOString(),
			issues_logged: failed,
		},
	};
}

// Helper to create a minimal track for testing
function createTrack(overrides: Partial<Track> = {}): Track {
	return {
		id: "02-01",
		initiative: null,
		intent: "Test track",
		state: "active/executing",
		plan_path: ".planning/phases/02-feature/02-01-PLAN.md",
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
		...overrides,
	};
}

describe("extractUATIssues", () => {
	test("returns empty array when no verification data", () => {
		const track = createTrack({ verification: undefined });
		expect(extractUATIssues(track)).toEqual([]);
	});

	test("returns empty array when no UAT checks", () => {
		const track = createTrack({
			verification: createUAT([]),
		});
		expect(extractUATIssues(track)).toEqual([]);
	});

	test("returns empty array when all checks pass", () => {
		const track = createTrack({
			verification: createUAT([
				createCheck({ name: "Feature A", status: "pass" }),
				createCheck({ name: "Feature B", status: "pass" }),
			]),
		});
		expect(extractUATIssues(track)).toEqual([]);
	});

	test("extracts failed checks as issues", () => {
		const track = createTrack({
			verification: createUAT([
				createCheck({
					name: "Feature A",
					status: "fail",
					output: "Button not working",
				}),
				createCheck({ name: "Feature B", status: "pass" }),
			]),
		});

		const issues = extractUATIssues(track);
		expect(issues).toHaveLength(1);
		expect(issues[0].id).toBe("uat-001");
		expect(issues[0].feature).toBe("Feature A");
		expect(issues[0].description).toBe("Button not working");
	});

	test("parses severity from output", () => {
		const track = createTrack({
			verification: createUAT([
				createCheck({
					name: "Critical",
					status: "fail",
					output: "App crashes (blocker)",
				}),
				createCheck({
					name: "Important",
					status: "fail",
					output: "Wrong color (minor)",
				}),
				createCheck({
					name: "Default",
					status: "fail",
					output: "No severity specified",
				}),
			]),
		});

		const issues = extractUATIssues(track);
		expect(issues).toHaveLength(3);
		expect(issues[0].severity).toBe("blocker");
		expect(issues[1].severity).toBe("minor");
		expect(issues[2].severity).toBe("major"); // Default
	});

	test("generates sequential IDs", () => {
		const track = createTrack({
			verification: createUAT([
				createCheck({ name: "A", status: "fail", output: "Issue 1" }),
				createCheck({ name: "B", status: "fail", output: "Issue 2" }),
				createCheck({ name: "C", status: "fail", output: "Issue 3" }),
			]),
		});

		const issues = extractUATIssues(track);
		expect(issues[0].id).toBe("uat-001");
		expect(issues[1].id).toBe("uat-002");
		expect(issues[2].id).toBe("uat-003");
	});

	test("skips failed checks without output", () => {
		const track = createTrack({
			verification: createUAT([
				createCheck({ name: "A", status: "fail", output: undefined }),
				createCheck({ name: "B", status: "fail", output: "Real issue" }),
			]),
		});

		const issues = extractUATIssues(track);
		expect(issues).toHaveLength(1);
		expect(issues[0].feature).toBe("B");
	});
});

describe("generateFixTasks", () => {
	test("returns empty array for no issues", () => {
		expect(generateFixTasks([])).toEqual([]);
	});

	test("creates one task per feature", () => {
		const issues: UATIssue[] = [
			{
				id: "uat-001",
				feature: "Login",
				description: "Issue 1",
				severity: "major",
			},
			{
				id: "uat-002",
				feature: "Login",
				description: "Issue 2",
				severity: "minor",
			},
			{
				id: "uat-003",
				feature: "Search",
				description: "Issue 3",
				severity: "major",
			},
		];

		const tasks = generateFixTasks(issues);
		expect(tasks).toHaveLength(2);

		const loginTask = tasks.find((t) => t.name.includes("Login"));
		expect(loginTask).toBeDefined();
		expect(loginTask?.issue_ids).toEqual(["uat-001", "uat-002"]);

		const searchTask = tasks.find((t) => t.name.includes("Search"));
		expect(searchTask).toBeDefined();
		expect(searchTask?.issue_ids).toEqual(["uat-003"]);
	});

	test("sorts issues by severity (blockers first)", () => {
		const issues: UATIssue[] = [
			{
				id: "uat-001",
				feature: "A",
				description: "Minor issue",
				severity: "minor",
			},
			{
				id: "uat-002",
				feature: "B",
				description: "Blocker",
				severity: "blocker",
			},
			{
				id: "uat-003",
				feature: "C",
				description: "Major issue",
				severity: "major",
			},
		];

		const tasks = generateFixTasks(issues);
		// Blocker feature should come first
		expect(tasks[0].name).toContain("B");
		expect(tasks[1].name).toContain("C");
		expect(tasks[2].name).toContain("A");
	});

	test("task includes all issue descriptions in action", () => {
		const issues: UATIssue[] = [
			{
				id: "uat-001",
				feature: "Login",
				description: "Button broken",
				severity: "major",
			},
			{
				id: "uat-002",
				feature: "Login",
				description: "Validation missing",
				severity: "minor",
			},
		];

		const tasks = generateFixTasks(issues);
		expect(tasks[0].action).toContain("Button broken");
		expect(tasks[0].action).toContain("Validation missing");
	});

	test("task verify contains feature name", () => {
		const issues: UATIssue[] = [
			{
				id: "uat-001",
				feature: "Login Form",
				description: "Issue",
				severity: "major",
			},
		];

		const tasks = generateFixTasks(issues);
		expect(tasks[0].verify).toContain("Login Form");
	});
});

describe("generateFixPlanContent", () => {
	test("generates valid markdown with frontmatter", () => {
		const plan = {
			phase: "02-feature",
			plan: "01",
			issues: [
				{
					id: "uat-001",
					feature: "Login",
					description: "Button broken",
					severity: "major" as const,
				},
			],
			tasks: [
				{
					name: "Fix: Login (uat-001)",
					issue_ids: ["uat-001"],
					action: "Fix the button",
					verify: "Test Login works",
					done: "Login issues resolved",
				},
			],
		};
		const track = createTrack();

		const content = generateFixPlanContent(plan, track);

		expect(content).toContain("---");
		expect(content).toContain("phase:");
		expect(content).toContain("plan:");
		expect(content).toContain("type: execute");
	});

	test("includes objective section", () => {
		const plan = { phase: "02", plan: "01", issues: [], tasks: [] };
		const track = createTrack();

		const content = generateFixPlanContent(plan, track);

		expect(content).toContain("<objective>");
		expect(content).toContain("Fix UAT issues");
		expect(content).toContain("</objective>");
	});

	test("includes context section with summary reference", () => {
		const plan = { phase: "02", plan: "01", issues: [], tasks: [] };
		const track = createTrack({
			plan_path: ".planning/phases/02-feature/02-01-PLAN.md",
		});

		const content = generateFixPlanContent(plan, track);

		expect(content).toContain("<context>");
		expect(content).toContain("@.planning/PROJECT.md");
		expect(content).toContain("02-01-SUMMARY.md");
		expect(content).toContain("</context>");
	});

	test("includes tasks section with XML structure", () => {
		const plan = {
			phase: "02",
			plan: "01",
			issues: [],
			tasks: [
				{
					name: "Fix Login",
					issue_ids: ["uat-001"],
					action: "Do the thing",
					verify: "Check it worked",
					done: "Task complete",
				},
			],
		};
		const track = createTrack();

		const content = generateFixPlanContent(plan, track);

		expect(content).toContain("<tasks>");
		expect(content).toContain('<task type="auto">');
		expect(content).toContain("<name>Fix Login</name>");
		expect(content).toContain("<action>Do the thing</action>");
		expect(content).toContain("<verify>Check it worked</verify>");
		expect(content).toContain("<done>Task complete</done>");
		expect(content).toContain("</tasks>");
	});

	test("includes verification section with issue checklist", () => {
		const plan = {
			phase: "02",
			plan: "01",
			issues: [
				{
					id: "uat-001",
					feature: "Login",
					description: "Issue",
					severity: "blocker" as const,
				},
				{
					id: "uat-002",
					feature: "Search",
					description: "Issue 2",
					severity: "minor" as const,
				},
			],
			tasks: [],
		};
		const track = createTrack();

		const content = generateFixPlanContent(plan, track);

		expect(content).toContain("<verification>");
		expect(content).toContain("- [ ] uat-001: Login (blocker)");
		expect(content).toContain("- [ ] uat-002: Search (minor)");
		expect(content).toContain("</verification>");
	});

	test("includes success criteria section", () => {
		const plan = { phase: "02", plan: "01", issues: [], tasks: [] };
		const track = createTrack();

		const content = generateFixPlanContent(plan, track);

		expect(content).toContain("<success_criteria>");
		expect(content).toContain("All UAT issues addressed");
		expect(content).toContain("</success_criteria>");
	});
});

describe("getFixPlanPath", () => {
	test("replaces PLAN with FIX-PLAN in path", () => {
		const track = createTrack({
			plan_path: ".planning/phases/02-feature/02-01-PLAN.md",
		});

		expect(getFixPlanPath(track)).toBe(
			".planning/phases/02-feature/02-01-FIX-PLAN.md",
		);
	});

	test("handles different path formats", () => {
		const track = createTrack({
			plan_path: "custom/path/05-03-PLAN.md",
		});

		expect(getFixPlanPath(track)).toBe("custom/path/05-03-FIX-PLAN.md");
	});
});
