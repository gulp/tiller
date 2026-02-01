/**
 * UAT (User Acceptance Testing) checklist generator
 *
 * Parses SUMMARY.md and generates testable checklist items
 */

// UAT check item with result tracking
export interface UATCheckItem {
	id: string; // "uat-001"
	feature: string; // Feature name from SUMMARY
	description: string; // What to test
	result?: "pass" | "fail" | "partial" | "skip";
	issue?: string; // Issue description if fail/partial
	severity?: "blocker" | "major" | "minor" | "cosmetic";
}

// UAT session state
export interface UATSession {
	run_id: string;
	started_at: string;
	completed_at?: string;
	checks: UATCheckItem[];
	issues_logged: number;
}

/**
 * Beads task structure from bd show --json
 */
interface BeadsTask {
	id: string;
	title: string;
	status: string;
	notes?: string;
}

interface BeadsEpic {
	id: string;
	title: string;
	dependents?: BeadsTask[];
}

/**
 * Extract epic_id from SUMMARY.md frontmatter
 */
export function extractEpicId(summaryContent: string): string | null {
	const match = summaryContent.match(/^epic_id:\s*(\S+)/m);
	return match ? match[1] : null;
}

/**
 * Get tasks from beads epic
 *
 * Deterministic: queries beads directly, no markdown parsing
 */
export async function getTasksFromBeads(epicId: string): Promise<BeadsTask[]> {
	const { execSync } = await import("node:child_process");

	try {
		const output = execSync(`bd show ${epicId} --json`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const data = JSON.parse(output) as BeadsEpic[];
		if (!data || data.length === 0) return [];

		const epic = data[0];
		if (!epic.dependents) return [];

		// Filter to tasks only (not sub-epics)
		return epic.dependents.filter((d) => d.title && d.title.length > 0);
	} catch {
		return [];
	}
}

/**
 * Extract deliverables from beads epic or fallback to SUMMARY parsing
 *
 * Priority:
 * 1. Beads epic tasks (deterministic)
 * 2. Fallback: parse SUMMARY.md (legacy)
 */
export async function extractDeliverablesAsync(
	summaryContent: string,
	epicId?: string | null,
): Promise<string[]> {
	// Try beads first
	const eid = epicId ?? extractEpicId(summaryContent);
	if (eid) {
		const tasks = await getTasksFromBeads(eid);
		if (tasks.length > 0) {
			return tasks.map((t) => t.title);
		}
	}

	// Fallback to sync version
	return extractDeliverables(summaryContent);
}

/**
 * Sync fallback: parse SUMMARY.md for deliverables
 * Used when beads epic not available
 */
export function extractDeliverables(summaryContent: string): string[] {
	const deliverables: string[] = [];

	// Look for ## Tasks section with numbered items
	const tasksMatch = summaryContent.match(
		/##\s*Tasks?\s*\n([\s\S]*?)(?=\n##|$)/i,
	);
	if (tasksMatch) {
		const section = tasksMatch[1];
		const numbered = section.match(/^\d+\.\s+(.+)$/gm);
		if (numbered) {
			for (const line of numbered) {
				let text = line.replace(/^\d+\.\s+/, "").trim();
				text = text.replace(
					/\s*[-–—]\s*(✓|✗|○)?\s*(closed|open|done|complete|completed|in.?progress).*$/i,
					"",
				);
				text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
				if (text && text.length > 3) {
					deliverables.push(text);
				}
			}
		}
	}

	return [...new Set(deliverables)];
}

/**
 * Generate UAT checklist from deliverables
 */
export function generateChecklist(deliverables: string[]): UATCheckItem[] {
	return deliverables.map((d, i) => ({
		id: `uat-${String(i + 1).padStart(3, "0")}`,
		feature: truncateFeature(d),
		description: d,
	}));
}

/**
 * Truncate feature name for display (max 50 chars)
 */
function truncateFeature(text: string): string {
	// Remove markdown formatting
	let clean = text
		.replace(/`([^`]+)`/g, "$1") // Remove inline code
		.replace(/\*\*([^*]+)\*\*/g, "$1") // Remove bold
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // Remove links

	if (clean.length > 50) {
		clean = `${clean.slice(0, 47)}...`;
	}
	return clean;
}

/**
 * Format checklist for display
 */
export function formatChecklist(checks: UATCheckItem[]): string {
	const lines: string[] = [];
	lines.push(`Testing ${checks.length} feature(s):\n`);

	for (const check of checks) {
		const icon = getResultIcon(check.result);
		lines.push(`${icon} [${check.id}] ${check.feature}`);
		if (check.issue) {
			lines.push(`     Issue: ${check.issue} (${check.severity || "unknown"})`);
		}
	}

	return lines.join("\n");
}

/**
 * Get icon for result
 */
function getResultIcon(result?: UATCheckItem["result"]): string {
	switch (result) {
		case "pass":
			return "✓";
		case "fail":
			return "✗";
		case "partial":
			return "◐";
		case "skip":
			return "○";
		default:
			return "□";
	}
}

/**
 * Get summary of UAT results
 */
export function getUATSummary(checks: UATCheckItem[]): {
	total: number;
	passed: number;
	failed: number;
	partial: number;
	skipped: number;
	issues: number;
} {
	const passed = checks.filter((c) => c.result === "pass").length;
	const failed = checks.filter((c) => c.result === "fail").length;
	const partial = checks.filter((c) => c.result === "partial").length;
	const skipped = checks.filter((c) => c.result === "skip").length;
	const issues = checks.filter((c) => c.issue).length;

	return {
		total: checks.length,
		passed,
		failed,
		partial,
		skipped,
		issues,
	};
}
