/**
 * Unit tests for Tiller lint module - PLAN.md linting with auto-fix
 *
 * Rules tested:
 * - no-hash-comments: Warn on # comment syntax in <context>
 * - require-objective: Error if missing <objective> section
 * - require-verification: Warn if missing <verification> section
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fixPlanLint,
	hasBlockingIssues,
	hasFixableIssues,
	type LintIssue,
	lintPlan,
} from "../../../src/tiller/lint/plan.js";

describe("tiller lint/plan", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`lint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	function writePlan(content: string): string {
		const planPath = join(testDir, "PLAN.md");
		writeFileSync(planPath, content);
		return planPath;
	}

	describe("lintPlan", () => {
		it("returns no issues for valid plan", () => {
			const content = `---
phase: test
plan: 01
---

<objective>
Test objective content
</objective>

<context>
Some context here
</context>

<verification>
- [ ] Check passes
</verification>
`;
			const planPath = writePlan(content);
			const issues = lintPlan(planPath);

			expect(issues).toHaveLength(0);
		});

		it("detects missing objective (error)", () => {
			const content = `---
phase: test
---

<context>
Some content
</context>
`;
			const planPath = writePlan(content);
			const issues = lintPlan(planPath);

			expect(issues.length).toBeGreaterThan(0);
			const objIssue = issues.find((i) => i.ruleId === "require-objective");
			expect(objIssue).toBeDefined();
			expect(objIssue?.severity).toBe("error");
		});

		it("detects missing verification (warning)", () => {
			const content = `---
phase: test
---

<objective>
Test objective
</objective>

<context>
Some content
</context>
`;
			const planPath = writePlan(content);
			const issues = lintPlan(planPath);

			const verifyIssue = issues.find(
				(i) => i.ruleId === "require-verification",
			);
			expect(verifyIssue).toBeDefined();
			expect(verifyIssue?.severity).toBe("warning");
		});

		it("detects hash comments in context (warning)", () => {
			const content = `---
phase: test
---

<objective>
Test objective
</objective>

<context>
# This is a hash comment
Some content
</context>

<verification>
- [ ] Check
</verification>
`;
			const planPath = writePlan(content);
			const issues = lintPlan(planPath);

			const hashIssue = issues.find((i) => i.ruleId === "no-hash-comments");
			expect(hashIssue).toBeDefined();
			expect(hashIssue?.severity).toBe("warning");
		});

		it("distinguishes errors from warnings", () => {
			const content = `---
phase: test
---

<context>
# Hash comment
</context>
`;
			const planPath = writePlan(content);
			const issues = lintPlan(planPath);

			const errors = issues.filter((i) => i.severity === "error");
			const warnings = issues.filter((i) => i.severity === "warning");

			expect(errors.length).toBeGreaterThan(0); // Missing objective
			expect(warnings.length).toBeGreaterThan(0); // Hash comment, missing verification
		});

		it("returns read error for missing file", () => {
			const issues = lintPlan("/nonexistent/path/PLAN.md");

			expect(issues.length).toBe(1);
			expect(issues[0].ruleId).toBe("read-error");
			expect(issues[0].severity).toBe("error");
		});
	});

	describe("hasBlockingIssues", () => {
		it("returns true when errors present", () => {
			const issues: LintIssue[] = [
				{ severity: "error", message: "test", ruleId: "test" },
			];
			expect(hasBlockingIssues(issues)).toBe(true);
		});

		it("returns false when only warnings present", () => {
			const issues: LintIssue[] = [
				{ severity: "warning", message: "test", ruleId: "test" },
			];
			expect(hasBlockingIssues(issues)).toBe(false);
		});

		it("returns false for empty array", () => {
			expect(hasBlockingIssues([])).toBe(false);
		});
	});

	describe("hasFixableIssues", () => {
		it("returns true for fixable rules", () => {
			const issues: LintIssue[] = [
				{ severity: "warning", message: "test", ruleId: "no-hash-comments" },
			];
			expect(hasFixableIssues(issues)).toBe(true);
		});

		it("returns false for non-fixable rules", () => {
			const issues: LintIssue[] = [
				{ severity: "error", message: "test", ruleId: "require-objective" },
			];
			expect(hasFixableIssues(issues)).toBe(false);
		});
	});

	describe("fixPlanLint", () => {
		it("can fix hash comments in context", () => {
			const content = `---
phase: test
---

<objective>
Test
</objective>

<context>
# Remove this hash
Content here
</context>

<tasks>
- Task
</tasks>

<verification>
- [ ] Check
</verification>
`;
			const planPath = writePlan(content);
			const result = fixPlanLint(planPath);

			if (result.fixed) {
				const newContent = readFileSync(planPath, "utf-8");
				expect(newContent).not.toContain("# Remove this hash");
				expect(newContent).toContain("Remove this hash");
			}
		});

		it("can add missing verification section", () => {
			const content = `---
phase: test
---

<objective>
Test objective
</objective>

<context>
Content
</context>

<tasks>
- Task
</tasks>
`;
			const planPath = writePlan(content);
			const result = fixPlanLint(planPath);

			if (result.fixed) {
				const newContent = readFileSync(planPath, "utf-8");
				expect(newContent).toContain("<verification>");
			}
		});

		it("returns fixed=false when no fixable issues", () => {
			const content = `---
phase: test
---

<objective>
Test
</objective>

<context>
Content
</context>

<verification>
- [ ] Check
</verification>
`;
			const planPath = writePlan(content);
			const result = fixPlanLint(planPath);

			expect(result.fixed).toBe(false);
			expect(result.changes).toHaveLength(0);
		});

		it("returns fixed=false for missing file", () => {
			const result = fixPlanLint("/nonexistent/path/PLAN.md");
			expect(result.fixed).toBe(false);
		});
	});
});
