/**
 * Fix plan generator
 *
 * Creates FIX-PLAN.md from UAT issues
 */

import type { Run, VerificationCheck } from "../types/index.js";

// UAT issue extracted from stored VerificationCheck
export interface UATIssue {
	id: string; // Generated from index: "uat-001"
	feature: string; // Feature that failed (from check.name)
	description: string; // Issue description (parsed from check.output)
	severity: "blocker" | "major" | "minor" | "cosmetic";
}

// Fix task to address UAT issues
export interface FixTask {
	name: string;
	issue_ids: string[]; // Which UAT issues this fixes
	action: string;
	verify: string;
	done: string;
}

// Complete fix plan
export interface FixPlan {
	phase: string;
	plan: string;
	issues: UATIssue[];
	tasks: FixTask[];
}

/**
 * Parse severity from stored output format: "issue text (severity)"
 */
function parseSeverity(output: string): {
	issue: string;
	severity: UATIssue["severity"];
} {
	const match = output.match(/^(.*?)\s*\((blocker|major|minor|cosmetic)\)$/);
	if (match) {
		return { issue: match[1], severity: match[2] as UATIssue["severity"] };
	}
	return { issue: output, severity: "major" };
}

/**
 * Extract UAT issues from track verification results
 * Parses stored VerificationCheck format back to UATIssue
 */
export function extractUATIssues(run: Run): UATIssue[] {
	const uat = run.verification?.uat;
	if (!uat || !uat.checks) {
		return [];
	}

	// Filter to failed checks with output (which contains the issue)
	return uat.checks
		.filter((c: VerificationCheck) => c.status === "fail" && c.output)
		.map((c: VerificationCheck, idx: number) => {
			const { issue, severity } = parseSeverity(c.output || "");
			return {
				id: `uat-${String(idx + 1).padStart(3, "0")}`,
				feature: c.name,
				description: issue,
				severity,
			};
		});
}

/**
 * Generate fix tasks from UAT issues
 * Groups by feature and prioritizes by severity
 */
export function generateFixTasks(issues: UATIssue[]): FixTask[] {
	if (issues.length === 0) return [];

	// Sort by severity (blockers first)
	const severityOrder = { blocker: 0, major: 1, minor: 2, cosmetic: 3 };
	const sorted = [...issues].sort(
		(a, b) => severityOrder[a.severity] - severityOrder[b.severity],
	);

	// Group by feature
	const byFeature = new Map<string, UATIssue[]>();
	for (const issue of sorted) {
		const existing = byFeature.get(issue.feature) || [];
		existing.push(issue);
		byFeature.set(issue.feature, existing);
	}

	// Create one task per feature
	const tasks: FixTask[] = [];
	for (const [feature, featureIssues] of byFeature) {
		const ids = featureIssues.map((i) => i.id);
		const descriptions = featureIssues
			.map((i) => `- ${i.description}`)
			.join("\n");
		const _highestSeverity = featureIssues[0].severity; // Already sorted

		tasks.push({
			name: `Fix: ${feature} (${ids.join(", ")})`,
			issue_ids: ids,
			action: `Address the following issue(s):\n${descriptions}`,
			verify: `Test that ${feature} works correctly`,
			done: `${feature} issues resolved (${ids.join(", ")})`,
		});
	}

	return tasks;
}

/**
 * Parse phase and plan from track's plan_path
 * e.g., ".planning/phases/02.1-workflow-engine/02.1-05-PLAN.md" -> { phase: "02.1-workflow-engine", plan: "05" }
 */
function parsePlanPath(planPath: string): { phase: string; plan: string } {
	const match = planPath.match(
		/phases\/([^/]+)\/[^/]*?(\d+(?:\.\d+)?)-\d+-PLAN\.md$/,
	);
	if (match) {
		return { phase: match[1], plan: match[2] };
	}

	// Fallback: try simpler pattern
	const simpleMatch = planPath.match(/(\d+(?:\.\d+)?)-(\d+)-PLAN\.md$/);
	if (simpleMatch) {
		return { phase: simpleMatch[1], plan: simpleMatch[2] };
	}

	return { phase: "unknown", plan: "fix" };
}

/**
 * Generate FIX-PLAN.md content
 */
export function generateFixPlanContent(plan: FixPlan, run: Run): string {
	const { phase, plan: planNum } = parsePlanPath(run.plan_path);
	const fixPlanNum = `${planNum}-fix`;

	const lines: string[] = [];

	// Frontmatter
	lines.push("---");
	lines.push(`phase: ${phase}`);
	lines.push(`plan: ${fixPlanNum}`);
	lines.push("type: execute");
	lines.push("wave: 1");
	lines.push("depends_on: []");
	lines.push("files_modified: []");
	lines.push("autonomous: true");
	lines.push("---");
	lines.push("");

	// Objective
	lines.push("<objective>");
	lines.push(`Fix UAT issues from Phase ${phase} Plan ${planNum}.`);
	lines.push("");
	lines.push("Purpose: Address issues found during user acceptance testing.");
	lines.push("Output: All UAT issues resolved.");
	lines.push("</objective>");
	lines.push("");

	// Context
	lines.push("<context>");
	lines.push("@.planning/PROJECT.md");
	lines.push(`@${run.plan_path.replace("-PLAN.md", "-SUMMARY.md")}`);
	lines.push("</context>");
	lines.push("");

	// Tasks
	lines.push("<tasks>");
	lines.push("");
	for (const task of plan.tasks) {
		lines.push('<task type="auto">');
		lines.push(`  <name>${task.name}</name>`);
		lines.push("  <files></files>");
		lines.push(`  <action>${task.action}</action>`);
		lines.push(`  <verify>${task.verify}</verify>`);
		lines.push(`  <done>${task.done}</done>`);
		lines.push("</task>");
		lines.push("");
	}
	lines.push("</tasks>");
	lines.push("");

	// Verification
	lines.push("<verification>");
	lines.push("Before declaring plan complete:");
	for (const issue of plan.issues) {
		lines.push(`- [ ] ${issue.id}: ${issue.feature} (${issue.severity})`);
	}
	lines.push("- [ ] All original UAT tests pass");
	lines.push("</verification>");
	lines.push("");

	// Success criteria
	lines.push("<success_criteria>");
	lines.push("- All UAT issues addressed");
	lines.push("- No regressions introduced");
	lines.push("- UAT re-test passes");
	lines.push("</success_criteria>");

	return lines.join("\n");
}

/**
 * Get the fix plan output path
 */
export function getFixPlanPath(run: Run): string {
	return run.plan_path.replace("-PLAN.md", "-FIX-PLAN.md");
}
