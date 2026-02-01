/**
 * Handoff state module for session continuity
 *
 * Creates and reads .continue-here.md files for context preservation
 * across sessions. These files capture the "mental context" that helps
 * resuming agents understand not just state, but intent and decisions.
 *
 * File location: Adjacent to PLAN.md (e.g., plans/tiller/04-phase/.continue-here.md)
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Run } from "../types/index.js";
import { logEvent } from "./events.js";
import { getRunPlanRef } from "./run.js";

// ============================================
// Handoff Context Types
// ============================================

/**
 * Decision with rationale (for context preservation)
 */
export interface HandoffDecision {
	decision: string;
	rationale: string;
}

/**
 * Blocker with status (for context preservation)
 */
export interface HandoffBlocker {
	issue: string;
	status: "active" | "workaround" | "resolved";
	workaround?: string;
}

/**
 * Full handoff context - the 7 categories
 *
 * Categories:
 * 1. current_state - Where exactly are we? Immediate context
 * 2. completed_work - What's done (list of completed items)
 * 3. remaining_work - What's left (list of pending items)
 * 4. decisions_made - Key decisions and their rationale
 * 5. blockers - Issues encountered and their status
 * 6. mental_context - What was the agent thinking? The "why"
 * 7. next_action - Specific first action when resuming
 */
export interface HandoffContext {
	// Category 1: Where are we?
	current_state: string;

	// Category 2: What's done?
	completed_work: string[];

	// Category 3: What's left?
	remaining_work: string[];

	// Category 4: Decisions made
	decisions_made: HandoffDecision[];

	// Category 5: Blockers
	blockers: HandoffBlocker[];

	// Category 6: Mental context (the "why")
	mental_context: string;

	// Category 7: What to do next
	next_action: string;
}

/**
 * Handoff file metadata (YAML frontmatter)
 */
export interface HandoffMetadata {
	phase: string;
	plan: string;
	run_id: string;
	state: string;
	created: string;
	updated: string;
}

/**
 * Complete handoff file structure
 */
export interface HandoffFile {
	metadata: HandoffMetadata;
	context: HandoffContext;
}

// ============================================
// Path Resolution
// ============================================

/**
 * Get the path to the .continue-here.md file for a track
 * Location: Adjacent to PLAN.md (same directory)
 */
export function getHandoffPath(track: Run): string {
	const planDir = dirname(track.plan_path);
	return join(planDir, ".continue-here.md");
}

/**
 * Check if a handoff file exists for a track
 */
export function handoffExists(track: Run): boolean {
	return existsSync(getHandoffPath(track));
}

// ============================================
// Handoff File Generation
// ============================================

/**
 * Format a HandoffContext into markdown sections
 */
function formatContextSections(context: HandoffContext): string {
	const sections: string[] = [];

	// Category 1: Current State
	sections.push(`## Current State

${context.current_state}`);

	// Category 2: Completed Work
	if (context.completed_work.length > 0) {
		sections.push(`## Completed Work

${context.completed_work.map((item) => `- ${item}`).join("\n")}`);
	} else {
		sections.push(`## Completed Work

(No items completed yet)`);
	}

	// Category 3: Remaining Work
	if (context.remaining_work.length > 0) {
		sections.push(`## Remaining Work

${context.remaining_work.map((item) => `- ${item}`).join("\n")}`);
	} else {
		sections.push(`## Remaining Work

(All work completed)`);
	}

	// Category 4: Decisions Made
	if (context.decisions_made.length > 0) {
		sections.push(`## Decisions Made

${context.decisions_made
	.map(
		(d) => `### ${d.decision}

${d.rationale}`,
	)
	.join("\n\n")}`);
	} else {
		sections.push(`## Decisions Made

(No significant decisions recorded)`);
	}

	// Category 5: Blockers
	if (context.blockers.length > 0) {
		const blockerLines = context.blockers.map((b) => {
			const statusEmoji =
				b.status === "resolved"
					? "✅"
					: b.status === "workaround"
						? "⚠️"
						: "🚫";
			const workaroundNote =
				b.workaround && b.status === "workaround"
					? ` (Workaround: ${b.workaround})`
					: "";
			return `- ${statusEmoji} **${b.status}**: ${b.issue}${workaroundNote}`;
		});
		sections.push(`## Blockers

${blockerLines.join("\n")}`);
	} else {
		sections.push(`## Blockers

(No blockers encountered)`);
	}

	// Category 6: Mental Context
	sections.push(`## Mental Context

${context.mental_context}`);

	// Category 7: Next Action
	sections.push(`## Next Action

**Start with:** ${context.next_action}`);

	return sections.join("\n\n");
}

/**
 * Format YAML frontmatter from metadata
 */
function formatFrontmatter(metadata: HandoffMetadata): string {
	return `---
phase: ${metadata.phase}
plan: ${metadata.plan}
run_id: ${metadata.run_id}
state: ${metadata.state}
created: ${metadata.created}
updated: ${metadata.updated}
---`;
}

/**
 * Create a handoff file for a track
 *
 * @param track - The track to create handoff for
 * @param context - The handoff context (7 categories)
 * @returns The path to the created handoff file
 */
export function createHandoff(track: Run, context: HandoffContext): string {
	const planRef = getRunPlanRef(track);
	const now = new Date().toISOString();

	// Parse plan ref into phase and plan number
	const refMatch = planRef.match(/^(\d+(?:\.\d+)?)-(\d+)$/);
	const phase = refMatch ? refMatch[1] : planRef;
	const plan = refMatch ? refMatch[2] : "01";

	const metadata: HandoffMetadata = {
		phase,
		plan,
		run_id: track.id,
		state: track.state,
		created: now,
		updated: now,
	};

	const content = `${formatFrontmatter(metadata)}

# Continue Here

This file was created by \`tiller pause\` to preserve context for session resumption.
Read this file with \`tiller prime --full\` to inject context into your session.

${formatContextSections(context)}
`;

	const handoffPath = getHandoffPath(track);
	writeFileSync(handoffPath, content, "utf-8");

	// Log event for audit trail
	logEvent({
		event: "handoff_created",
		track: track.id,
		plan: planRef,
		path: handoffPath,
	});

	return handoffPath;
}

/**
 * Update an existing handoff file with new context
 */
export function updateHandoff(track: Run, context: HandoffContext): string {
	const handoffPath = getHandoffPath(track);
	const existing = readHandoff(track);

	const planRef = getRunPlanRef(track);
	const now = new Date().toISOString();

	// Parse plan ref into phase and plan number
	const refMatch = planRef.match(/^(\d+(?:\.\d+)?)-(\d+)$/);
	const phase = refMatch ? refMatch[1] : planRef;
	const plan = refMatch ? refMatch[2] : "01";

	const metadata: HandoffMetadata = {
		phase,
		plan,
		run_id: track.id,
		state: track.state,
		created: existing?.metadata.created ?? now,
		updated: now,
	};

	const content = `${formatFrontmatter(metadata)}

# Continue Here

This file was created by \`tiller pause\` to preserve context for session resumption.
Read this file with \`tiller prime --full\` to inject context into your session.

${formatContextSections(context)}
`;

	writeFileSync(handoffPath, content, "utf-8");

	// Log event for audit trail
	logEvent({
		event: "handoff_updated",
		track: track.id,
		plan: planRef,
		path: handoffPath,
	});

	return handoffPath;
}

// ============================================
// Handoff File Reading
// ============================================

/**
 * Parse YAML frontmatter from a handoff file
 */
function parseFrontmatter(content: string): HandoffMetadata | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const yaml = match[1];
	const metadata: Partial<HandoffMetadata> = {};

	// Simple YAML parsing (key: value format)
	for (const line of yaml.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		if (key && value) {
			metadata[key as keyof HandoffMetadata] = value;
		}
	}

	// Validate required fields
	if (
		!metadata.phase ||
		!metadata.plan ||
		!metadata.run_id ||
		!metadata.state
	) {
		return null;
	}

	return metadata as HandoffMetadata;
}

/**
 * Parse a section from the markdown content
 */
function parseSection(content: string, heading: string): string | null {
	// Match ## Heading followed by content until next ## or end
	const regex = new RegExp(
		`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`,
		"i",
	);
	const match = content.match(regex);
	return match ? match[1].trim() : null;
}

/**
 * Parse a list section (bulleted items)
 */
function parseListSection(content: string, heading: string): string[] {
	const section = parseSection(content, heading);
	if (!section || section.includes("(No ") || section.includes("(All ")) {
		return [];
	}

	return section
		.split("\n")
		.filter((line) => line.trim().startsWith("-"))
		.map((line) => line.replace(/^-\s*/, "").trim());
}

/**
 * Parse decisions from the Decisions Made section
 */
function parseDecisions(content: string): HandoffDecision[] {
	const section = parseSection(content, "Decisions Made");
	if (!section || section.includes("(No significant")) {
		return [];
	}

	const decisions: HandoffDecision[] = [];
	const decisionBlocks = section.split(/\n### /).filter(Boolean);

	for (const block of decisionBlocks) {
		const lines = block.trim().split("\n");
		const decision = lines[0].replace(/^### /, "").trim();
		const rationale = lines.slice(1).join("\n").trim();
		if (decision) {
			decisions.push({ decision, rationale: rationale || "" });
		}
	}

	return decisions;
}

/**
 * Parse blockers from the Blockers section
 */
function parseBlockers(content: string): HandoffBlocker[] {
	const section = parseSection(content, "Blockers");
	if (!section || section.includes("(No blockers")) {
		return [];
	}

	const blockers: HandoffBlocker[] = [];
	const lines = section.split("\n").filter((line) => line.trim().startsWith("-"));

	for (const line of lines) {
		// Pattern: - {emoji(s)} **{status}**: {issue} (Workaround: {workaround})?
		// Note: Emojis can be multi-codepoint (e.g., ⚠️ is U+26A0 + U+FE0F)
		// Using .+? to match any emoji sequence before **
		const match = line.match(
			/^-\s*.+?\s*\*\*(\w+)\*\*:\s*(.+?)(?:\s*\(Workaround:\s*(.+?)\))?$/,
		);
		if (match) {
			const status = match[1].toLowerCase() as
				| "active"
				| "workaround"
				| "resolved";
			blockers.push({
				issue: match[2].trim(),
				status,
				workaround: match[3]?.trim(),
			});
		}
	}

	return blockers;
}

/**
 * Read and parse a handoff file for a track
 *
 * @param track - The track to read handoff for
 * @returns The parsed handoff file, or null if not found
 */
export function readHandoff(track: Run): HandoffFile | null {
	const handoffPath = getHandoffPath(track);

	if (!existsSync(handoffPath)) {
		return null;
	}

	try {
		const content = readFileSync(handoffPath, "utf-8");
		const metadata = parseFrontmatter(content);

		if (!metadata) {
			return null;
		}

		const context: HandoffContext = {
			current_state: parseSection(content, "Current State") ?? "",
			completed_work: parseListSection(content, "Completed Work"),
			remaining_work: parseListSection(content, "Remaining Work"),
			decisions_made: parseDecisions(content),
			blockers: parseBlockers(content),
			mental_context: parseSection(content, "Mental Context") ?? "",
			next_action:
				parseSection(content, "Next Action")?.replace(
					/^\*\*Start with:\*\*\s*/,
					"",
				) ?? "",
		};

		return { metadata, context };
	} catch {
		return null;
	}
}

/**
 * Delete a handoff file for a track (e.g., when completing or abandoning)
 */
export function deleteHandoff(track: Run): boolean {
	const handoffPath = getHandoffPath(track);

	if (!existsSync(handoffPath)) {
		return false;
	}

	try {
		unlinkSync(handoffPath);
		logEvent({
			event: "handoff_deleted",
			track: track.id,
			plan: getRunPlanRef(track),
			path: handoffPath,
		});
		return true;
	} catch {
		return false;
	}
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Create a minimal handoff context with defaults
 */
export function createMinimalContext(
	currentState: string,
	nextAction: string,
): HandoffContext {
	return {
		current_state: currentState,
		completed_work: [],
		remaining_work: [],
		decisions_made: [],
		blockers: [],
		mental_context: "Session paused. Review track state before resuming.",
		next_action: nextAction,
	};
}

/**
 * Get handoff context as a formatted string for injection into prompts
 */
export function formatHandoffForInjection(handoff: HandoffFile): string {
	const { metadata, context } = handoff;

	return `## Session Context (from .continue-here.md)

**Plan:** ${metadata.phase}-${metadata.plan} | **State:** ${metadata.state} | **Last Updated:** ${metadata.updated}

### Where We Left Off
${context.current_state}

### Completed Work
${context.completed_work.length > 0 ? context.completed_work.map((w) => `- ${w}`).join("\n") : "(None)"}

### Remaining Work
${context.remaining_work.length > 0 ? context.remaining_work.map((w) => `- ${w}`).join("\n") : "(None)"}

### Key Decisions
${
	context.decisions_made.length > 0
		? context.decisions_made.map((d) => `- **${d.decision}**: ${d.rationale}`).join("\n")
		: "(None)"
}

### Blockers
${
	context.blockers.length > 0
		? context.blockers.map((b) => `- [${b.status}] ${b.issue}`).join("\n")
		: "(None)"
}

### Mental Context
${context.mental_context}

### Next Action
**Start with:** ${context.next_action}
`;
}
