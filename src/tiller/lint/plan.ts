/**
 * PLAN.md linting - rule-based with auto-fix support
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dump } from "js-yaml";
import { extractHtmlTag } from "../markdown/parser.js";

export interface LintIssue {
	severity: "error" | "warning";
	message: string;
	line?: number;
	ruleId: string;
}

export interface LintRule {
	id: string;
	severity: "error" | "warning";
	check: (
		content: string,
		lines: string[],
	) => { message: string; line?: number } | null;
	fix?: (content: string) => string;
}

/**
 * Lint rules for PLAN.md files
 */
const LINT_RULES: LintRule[] = [
	{
		id: "no-hash-comments",
		severity: "warning",
		check: (content, lines) => {
			const ctx = extractHtmlTag(content, "context");
			if (!ctx) return null;
			for (const line of ctx.split("\n")) {
				if (line.match(/^#\s/)) {
					const lineNum = lines.findIndex((l) => l.includes(line.trim())) + 1;
					return {
						message:
							"<context> uses # comment syntax - prefer plain prose or markdown lists",
						line: lineNum || undefined,
					};
				}
			}
			return null;
		},
		fix: (content) => {
			const ctx = extractHtmlTag(content, "context");
			if (!ctx) return content;
			const fixed = ctx
				.split("\n")
				.map((l) => l.replace(/^#\s*/, ""))
				.join("\n");
			return content.replace(ctx, fixed);
		},
	},
	{
		id: "require-objective",
		severity: "error",
		check: (content) => {
			if (!extractHtmlTag(content, "objective")) {
				return { message: "Missing <objective> section" };
			}
			return null;
		},
		// No auto-fix - requires human input
	},
	{
		id: "require-verification",
		severity: "warning",
		check: (content) => {
			// Check both AST and raw text (nested code fences can break AST parsing)
			if (extractHtmlTag(content, "verification")) return null;
			if (content.includes("<verification>")) return null;
			return { message: "Missing <verification> section" };
		},
		fix: (content) => {
			// Don't add if already exists (check both AST and raw text for robustness)
			// Raw text check handles cases where nested code fences break AST parsing
			if (extractHtmlTag(content, "verification")) return content;
			if (content.includes("<verification>")) return content;

			const tasksEnd = content.indexOf("</tasks>");
			if (tasksEnd === -1) return content;
			const insertPos = content.indexOf("\n", tasksEnd) + 1;
			const section = `\n<verification>\n- [ ] \`tsc --noEmit\` passes\n</verification>\n`;
			return content.slice(0, insertPos) + section + content.slice(insertPos);
		},
	},
];

/**
 * Lint a PLAN.md file
 */
export function lintPlan(planPath: string): LintIssue[] {
	let content: string;
	try {
		content = readFileSync(planPath, "utf-8");
	} catch {
		return [
			{
				severity: "error",
				message: `Cannot read file: ${planPath}`,
				ruleId: "read-error",
			},
		];
	}

	const lines = content.split("\n");
	const issues: LintIssue[] = [];

	for (const rule of LINT_RULES) {
		const result = rule.check(content, lines);
		if (result) {
			issues.push({
				severity: rule.severity,
				message: result.message,
				line: result.line,
				ruleId: rule.id,
			});
		}
	}

	return issues;
}

/**
 * Auto-fix lint issues in a PLAN.md file
 */
export function fixPlanLint(planPath: string): {
	fixed: boolean;
	changes: string[];
} {
	let content: string;
	try {
		content = readFileSync(planPath, "utf-8");
	} catch {
		return { fixed: false, changes: [] };
	}

	const changes: string[] = [];
	let newContent = content;
	const lines = content.split("\n");

	for (const rule of LINT_RULES) {
		const result = rule.check(newContent, lines);
		if (result && rule.fix) {
			const fixed = rule.fix(newContent);
			if (fixed !== newContent) {
				newContent = fixed;
				changes.push(`[${rule.id}] ${result.message}`);
			}
		}
	}

	if (changes.length > 0) {
		writeFileSync(planPath, newContent);
		return { fixed: true, changes };
	}

	return { fixed: false, changes: [] };
}

/**
 * Format lint issues for console output
 */
export function formatLintIssues(
	issues: LintIssue[],
	planPath: string,
): string {
	if (issues.length === 0) return "";

	const lines: string[] = [`Lint issues in ${planPath}:`];
	for (const issue of issues) {
		const prefix = issue.severity === "error" ? "✗" : "⚠";
		const loc = issue.line ? `:${issue.line}` : "";
		lines.push(`  ${prefix} ${issue.message}${loc}`);
	}
	return lines.join("\n");
}

/**
 * Check if lint issues should block execution
 */
export function hasBlockingIssues(issues: LintIssue[]): boolean {
	return issues.some((i) => i.severity === "error");
}

/**
 * Check if any issues have auto-fix available
 */
export function hasFixableIssues(issues: LintIssue[]): boolean {
	const fixableRules = LINT_RULES.filter((r) => r.fix).map((r) => r.id);
	return issues.some((i) => fixableRules.includes(i.ruleId));
}

/**
 * Format lint issues as TOON for agent decision
 */
export function formatLintTOON(
	issues: LintIssue[],
	planPath: string,
	ref: string,
): string {
	const hasErrors = hasBlockingIssues(issues);
	const canFix = hasFixableIssues(issues);

	const options: { label: string; action: string }[] = [];

	// Add auto-fix option if any issues are fixable
	if (canFix) {
		options.push({ label: "Auto-fix", action: `tiller lint ${ref} --fix` });
	}

	options.push({
		label: "Continue anyway",
		action: `tiller start ${ref} --skip-lint`,
	});

	const toon = {
		lint: {
			plan: ref,
			path: planPath,
			issues: issues.map((i) => ({
				severity: i.severity,
				message: i.message,
				line: i.line,
			})),
			question: hasErrors
				? "Plan has lint errors. Fix before starting?"
				: "Plan has lint warnings. Continue anyway?",
			options,
		},
	};

	const yaml = dump(toon, { indent: 2, lineWidth: -1 });

	return `Data is in TOON format (2-space indent YAML).
\`\`\`toon
${yaml.trim()}
\`\`\`
Task: Use AskUserQuestion to present options (single question, multiSelect: false)`;
}
