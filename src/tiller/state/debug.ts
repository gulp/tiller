/**
 * Debug state module for persistent debugging sessions
 *
 * Creates and manages DEBUG.md files in .planning/debug/ that persist
 * across context resets (/clear). Implements scientific method workflow:
 * Evidence -> Hypothesis -> Test -> Eliminate/Confirm
 *
 * File structure:
 * - Active sessions: .planning/debug/[slug].md
 * - Resolved sessions: .planning/debug/resolved/[slug].md
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { logEvent } from "./events.js";
import { findProjectRoot } from "./paths.js";

// ============================================
// Debug Session Types
// ============================================

/**
 * Debug session status (scientific method stages)
 */
export type DebugStatus =
	| "evidence-gathering" // Initial investigation
	| "hypothesis-testing" // Testing a hypothesis
	| "root-cause-confirmed" // Root cause identified
	| "resolved" // Fixed and verified
	| "abandoned"; // Gave up or no longer relevant

/**
 * Evidence item collected during investigation
 */
export interface DebugEvidence {
	description: string;
	source: string; // file path, command, etc.
	found_at: string; // ISO timestamp
}

/**
 * Hypothesis with test results
 */
export interface DebugHypothesis {
	description: string;
	status: "pending" | "confirmed" | "eliminated";
	test_performed?: string;
	test_result?: string;
	tested_at?: string; // ISO timestamp
}

/**
 * Debug session context - the 6 categories
 *
 * Categories:
 * 1. symptoms - What went wrong (error messages, unexpected behavior)
 * 2. evidence - What was found during investigation
 * 3. hypotheses - Possible root causes being tested
 * 4. root_cause - Confirmed root cause (if found)
 * 5. fix_applied - Description of the fix
 * 6. verification - How fix was verified
 */
export interface DebugContext {
	// Category 1: What went wrong?
	symptoms: {
		description: string;
		error_messages: string[];
		timeline: string; // When did it start?
		reproduction_steps: string[];
	};

	// Category 2: What was found?
	evidence: DebugEvidence[];

	// Category 3: Possible root causes
	hypotheses: DebugHypothesis[];

	// Category 4: Confirmed root cause (if found)
	root_cause: string | null;

	// Category 5: Fix applied
	fix_applied: string | null;

	// Category 6: Verification
	verification: string | null;
}

/**
 * Debug file metadata (YAML frontmatter)
 */
export interface DebugMetadata {
	id: string;
	slug: string;
	title: string;
	status: DebugStatus;
	created: string; // ISO timestamp
	updated: string; // ISO timestamp
	run_id?: string; // Optional linked tiller run
}

/**
 * Complete debug session structure
 */
export interface DebugSession {
	metadata: DebugMetadata;
	context: DebugContext;
}

// ============================================
// Path Resolution
// ============================================

const DEBUG_DIR = ".planning/debug";
const RESOLVED_DIR = ".planning/debug/resolved";

/**
 * Ensure debug directories exist
 */
function ensureDebugDirs(): void {
	const projectRoot = findProjectRoot();
	const debugDir = join(projectRoot, DEBUG_DIR);
	const resolvedDir = join(projectRoot, RESOLVED_DIR);

	if (!existsSync(debugDir)) {
		mkdirSync(debugDir, { recursive: true });
	}
	if (!existsSync(resolvedDir)) {
		mkdirSync(resolvedDir, { recursive: true });
	}
}

/**
 * Get path to debug directory
 */
export function getDebugDir(): string {
	return join(findProjectRoot(), DEBUG_DIR);
}

/**
 * Get path to resolved debug directory
 */
export function getResolvedDebugDir(): string {
	return join(findProjectRoot(), RESOLVED_DIR);
}

/**
 * Get path to a debug session file by slug
 */
export function getDebugPath(slug: string): string {
	return join(getDebugDir(), `${slug}.md`);
}

/**
 * Get path to a resolved debug session file by slug
 */
export function getResolvedDebugPath(slug: string): string {
	return join(getResolvedDebugDir(), `${slug}.md`);
}

/**
 * Generate a slug from a title
 */
export function generateSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);
}

/**
 * Check if a debug session exists by slug
 */
export function debugSessionExists(slug: string): boolean {
	return existsSync(getDebugPath(slug));
}

// ============================================
// Debug File Generation
// ============================================

/**
 * Format YAML frontmatter from metadata
 */
function formatFrontmatter(metadata: DebugMetadata): string {
	const lines = [
		"---",
		`id: ${metadata.id}`,
		`slug: ${metadata.slug}`,
		`title: ${metadata.title}`,
		`status: ${metadata.status}`,
		`created: ${metadata.created}`,
		`updated: ${metadata.updated}`,
	];

	if (metadata.run_id) {
		lines.push(`run_id: ${metadata.run_id}`);
	}

	lines.push("---");
	return lines.join("\n");
}

/**
 * Format context sections as markdown
 */
function formatContextSections(context: DebugContext): string {
	const sections: string[] = [];

	// Symptoms section
	sections.push(`## Symptoms

**Description:** ${context.symptoms.description || "(Not yet documented)"}

**Timeline:** ${context.symptoms.timeline || "(Unknown)"}

### Error Messages
${
	context.symptoms.error_messages.length > 0
		? context.symptoms.error_messages.map((e) => `\`\`\`\n${e}\n\`\`\``).join("\n\n")
		: "(No error messages captured)"
}

### Reproduction Steps
${
	context.symptoms.reproduction_steps.length > 0
		? context.symptoms.reproduction_steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
		: "(Steps not documented)"
}`);

	// Evidence section
	sections.push(`## Evidence

${
	context.evidence.length > 0
		? context.evidence
				.map(
					(e) => `### ${e.description}
- **Source:** ${e.source}
- **Found at:** ${e.found_at}`,
				)
				.join("\n\n")
		: "(No evidence collected yet)"
}`);

	// Hypotheses section
	sections.push(`## Hypotheses

${
	context.hypotheses.length > 0
		? context.hypotheses
				.map((h) => {
					const statusIcon =
						h.status === "confirmed"
							? "**[CONFIRMED]**"
							: h.status === "eliminated"
								? "~~[ELIMINATED]~~"
								: "[PENDING]";
					let entry = `### ${statusIcon} ${h.description}`;
					if (h.test_performed) {
						entry += `\n- **Test:** ${h.test_performed}`;
					}
					if (h.test_result) {
						entry += `\n- **Result:** ${h.test_result}`;
					}
					if (h.tested_at) {
						entry += `\n- **Tested at:** ${h.tested_at}`;
					}
					return entry;
				})
				.join("\n\n")
		: "(No hypotheses recorded)"
}`);

	// Root Cause section
	sections.push(`## Root Cause

${context.root_cause || "(Not yet confirmed)"}`);

	// Fix Applied section
	sections.push(`## Fix Applied

${context.fix_applied || "(No fix applied yet)"}`);

	// Verification section
	sections.push(`## Verification

${context.verification || "(Not yet verified)"}`);

	return sections.join("\n\n");
}

/**
 * Create a new debug session
 */
export function createDebugSession(
	title: string,
	initialSymptoms?: string,
	runId?: string,
): DebugSession {
	ensureDebugDirs();

	const now = new Date().toISOString();
	const slug = generateSlug(title);
	const id = `debug-${slug}-${Date.now()}`;

	const metadata: DebugMetadata = {
		id,
		slug,
		title,
		status: "evidence-gathering",
		created: now,
		updated: now,
		run_id: runId,
	};

	const context: DebugContext = {
		symptoms: {
			description: initialSymptoms ?? "",
			error_messages: [],
			timeline: "",
			reproduction_steps: [],
		},
		evidence: [],
		hypotheses: [],
		root_cause: null,
		fix_applied: null,
		verification: null,
	};

	const session: DebugSession = { metadata, context };

	// Write the file
	saveDebugSession(session);

	// Log event
	logEvent({
		event: "debug_session_created",
		debug_id: id,
		slug,
		title,
		track: runId,
	});

	return session;
}

/**
 * Save a debug session to file
 */
export function saveDebugSession(session: DebugSession): string {
	ensureDebugDirs();

	const content = `${formatFrontmatter(session.metadata)}

# Debug: ${session.metadata.title}

This file tracks a debugging session using the scientific method.
Update it constantly as you investigate. It survives \`/clear\`.

**Status:** ${session.metadata.status}

${formatContextSections(session.context)}
`;

	const path = getDebugPath(session.metadata.slug);
	writeFileSync(path, content, "utf-8");

	return path;
}

// ============================================
// Debug File Reading
// ============================================

/**
 * Parse YAML frontmatter from a debug file
 */
function parseFrontmatter(content: string): DebugMetadata | null {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;

	const yaml = match[1];
	const metadata: Partial<DebugMetadata> = {};

	for (const line of yaml.split("\n")) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		if (key && value) {
			metadata[key as keyof DebugMetadata] = value as never;
		}
	}

	// Validate required fields
	if (
		!metadata.id ||
		!metadata.slug ||
		!metadata.title ||
		!metadata.status ||
		!metadata.created
	) {
		return null;
	}

	return metadata as DebugMetadata;
}

/**
 * Parse a section from the markdown content
 */
function parseSection(content: string, heading: string): string | null {
	const regex = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "i");
	const match = content.match(regex);
	return match ? match[1].trim() : null;
}

/**
 * Parse symptoms from content
 */
function parseSymptoms(content: string): DebugContext["symptoms"] {
	const section = parseSection(content, "Symptoms");
	if (!section) {
		return {
			description: "",
			error_messages: [],
			timeline: "",
			reproduction_steps: [],
		};
	}

	// Parse description
	const descMatch = section.match(/\*\*Description:\*\*\s*(.+?)(?=\n|$)/);
	const description = descMatch?.[1]?.trim() || "";

	// Parse timeline
	const timelineMatch = section.match(/\*\*Timeline:\*\*\s*(.+?)(?=\n|$)/);
	const timeline = timelineMatch?.[1]?.trim() || "";

	// Parse error messages (code blocks)
	const errorMatches = section.matchAll(/```\n([\s\S]*?)\n```/g);
	const error_messages: string[] = [];
	for (const match of errorMatches) {
		if (match[1]) error_messages.push(match[1]);
	}

	// Parse reproduction steps
	const stepsSection = section.match(
		/### Reproduction Steps\n([\s\S]*?)(?=\n###|$)/,
	);
	const reproduction_steps: string[] = [];
	if (stepsSection?.[1]) {
		const lines = stepsSection[1].split("\n");
		for (const line of lines) {
			const stepMatch = line.match(/^\d+\.\s*(.+)/);
			if (stepMatch?.[1]) {
				reproduction_steps.push(stepMatch[1].trim());
			}
		}
	}

	return { description, error_messages, timeline, reproduction_steps };
}

/**
 * Parse evidence from content
 */
function parseEvidence(content: string): DebugEvidence[] {
	const section = parseSection(content, "Evidence");
	if (!section || section.includes("(No evidence")) {
		return [];
	}

	const evidence: DebugEvidence[] = [];
	const blocks = section.split(/\n### /).filter(Boolean);

	for (const block of blocks) {
		const lines = block.trim().split("\n");
		const description = lines[0].replace(/^### /, "").trim();
		if (!description) continue;

		let source = "";
		let found_at = "";

		for (const line of lines.slice(1)) {
			const sourceMatch = line.match(/- \*\*Source:\*\*\s*(.+)/);
			if (sourceMatch) source = sourceMatch[1].trim();

			const foundMatch = line.match(/- \*\*Found at:\*\*\s*(.+)/);
			if (foundMatch) found_at = foundMatch[1].trim();
		}

		if (description) {
			evidence.push({ description, source, found_at });
		}
	}

	return evidence;
}

/**
 * Parse hypotheses from content
 */
function parseHypotheses(content: string): DebugHypothesis[] {
	const section = parseSection(content, "Hypotheses");
	if (!section || section.includes("(No hypotheses")) {
		return [];
	}

	const hypotheses: DebugHypothesis[] = [];
	const blocks = section.split(/\n### /).filter(Boolean);

	for (const block of blocks) {
		const lines = block.trim().split("\n");
		const headerLine = lines[0].replace(/^### /, "").trim();

		// Parse status and description from header
		let status: DebugHypothesis["status"] = "pending";
		let description = headerLine;

		if (headerLine.includes("[CONFIRMED]")) {
			status = "confirmed";
			description = headerLine.replace(/\*\*\[CONFIRMED\]\*\*\s*/, "");
		} else if (headerLine.includes("[ELIMINATED]")) {
			status = "eliminated";
			description = headerLine.replace(/~~\[ELIMINATED\]~~\s*/, "");
		} else if (headerLine.includes("[PENDING]")) {
			description = headerLine.replace(/\[PENDING\]\s*/, "");
		}

		if (!description) continue;

		let test_performed: string | undefined;
		let test_result: string | undefined;
		let tested_at: string | undefined;

		for (const line of lines.slice(1)) {
			const testMatch = line.match(/- \*\*Test:\*\*\s*(.+)/);
			if (testMatch) test_performed = testMatch[1].trim();

			const resultMatch = line.match(/- \*\*Result:\*\*\s*(.+)/);
			if (resultMatch) test_result = resultMatch[1].trim();

			const testedMatch = line.match(/- \*\*Tested at:\*\*\s*(.+)/);
			if (testedMatch) tested_at = testedMatch[1].trim();
		}

		hypotheses.push({
			description,
			status,
			test_performed,
			test_result,
			tested_at,
		});
	}

	return hypotheses;
}

/**
 * Read and parse a debug session from file
 */
export function readDebugSession(slug: string): DebugSession | null {
	const path = getDebugPath(slug);

	if (!existsSync(path)) {
		// Check resolved directory
		const resolvedPath = getResolvedDebugPath(slug);
		if (!existsSync(resolvedPath)) {
			return null;
		}
		// Read from resolved directory
		const content = readFileSync(resolvedPath, "utf-8");
		return parseDebugContent(content);
	}

	const content = readFileSync(path, "utf-8");
	return parseDebugContent(content);
}

/**
 * Parse debug session from file content
 */
function parseDebugContent(content: string): DebugSession | null {
	const metadata = parseFrontmatter(content);
	if (!metadata) return null;

	// Parse root cause
	const rootCauseSection = parseSection(content, "Root Cause");
	const root_cause =
		rootCauseSection && !rootCauseSection.includes("(Not yet")
			? rootCauseSection
			: null;

	// Parse fix applied
	const fixSection = parseSection(content, "Fix Applied");
	const fix_applied =
		fixSection && !fixSection.includes("(No fix") ? fixSection : null;

	// Parse verification
	const verifySection = parseSection(content, "Verification");
	const verification =
		verifySection && !verifySection.includes("(Not yet")
			? verifySection
			: null;

	const context: DebugContext = {
		symptoms: parseSymptoms(content),
		evidence: parseEvidence(content),
		hypotheses: parseHypotheses(content),
		root_cause,
		fix_applied,
		verification,
	};

	return { metadata, context };
}

// ============================================
// Debug Session Management
// ============================================

/**
 * List all active debug sessions
 */
export function listDebugSessions(): DebugSession[] {
	const debugDir = getDebugDir();
	if (!existsSync(debugDir)) {
		return [];
	}

	const sessions: DebugSession[] = [];
	const files = readdirSync(debugDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		const slug = basename(file, ".md");
		const session = readDebugSession(slug);
		if (session) {
			sessions.push(session);
		}
	}

	// Sort by updated date, most recent first
	return sessions.sort(
		(a, b) =>
			new Date(b.metadata.updated).getTime() -
			new Date(a.metadata.updated).getTime(),
	);
}

/**
 * List resolved debug sessions
 */
export function listResolvedSessions(): DebugSession[] {
	const resolvedDir = getResolvedDebugDir();
	if (!existsSync(resolvedDir)) {
		return [];
	}

	const sessions: DebugSession[] = [];
	const files = readdirSync(resolvedDir).filter((f) => f.endsWith(".md"));

	for (const file of files) {
		const slug = basename(file, ".md");
		const path = getResolvedDebugPath(slug);
		const content = readFileSync(path, "utf-8");
		const session = parseDebugContent(content);
		if (session) {
			sessions.push(session);
		}
	}

	return sessions.sort(
		(a, b) =>
			new Date(b.metadata.updated).getTime() -
			new Date(a.metadata.updated).getTime(),
	);
}

/**
 * Update a debug session's status
 */
export function updateDebugStatus(
	slug: string,
	status: DebugStatus,
): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	session.metadata.status = status;
	session.metadata.updated = new Date().toISOString();
	saveDebugSession(session);

	logEvent({
		event: "debug_status_updated",
		debug_id: session.metadata.id,
		slug,
		status,
	});

	return session;
}

/**
 * Add evidence to a debug session
 */
export function addDebugEvidence(
	slug: string,
	evidence: Omit<DebugEvidence, "found_at">,
): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	session.context.evidence.push({
		...evidence,
		found_at: new Date().toISOString(),
	});
	session.metadata.updated = new Date().toISOString();
	saveDebugSession(session);

	return session;
}

/**
 * Add a hypothesis to a debug session
 */
export function addDebugHypothesis(
	slug: string,
	description: string,
): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	session.context.hypotheses.push({
		description,
		status: "pending",
	});
	session.metadata.updated = new Date().toISOString();
	saveDebugSession(session);

	return session;
}

/**
 * Update a hypothesis test result
 */
export function updateHypothesis(
	slug: string,
	hypothesisIndex: number,
	update: {
		status?: DebugHypothesis["status"];
		test_performed?: string;
		test_result?: string;
	},
): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	const hypothesis = session.context.hypotheses[hypothesisIndex];
	if (!hypothesis) return null;

	if (update.status !== undefined) hypothesis.status = update.status;
	if (update.test_performed !== undefined)
		hypothesis.test_performed = update.test_performed;
	if (update.test_result !== undefined)
		hypothesis.test_result = update.test_result;

	if (update.test_performed || update.test_result) {
		hypothesis.tested_at = new Date().toISOString();
	}

	session.metadata.updated = new Date().toISOString();
	saveDebugSession(session);

	return session;
}

/**
 * Confirm root cause and update status
 */
export function confirmRootCause(
	slug: string,
	rootCause: string,
): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	session.context.root_cause = rootCause;
	session.metadata.status = "root-cause-confirmed";
	session.metadata.updated = new Date().toISOString();
	saveDebugSession(session);

	logEvent({
		event: "debug_root_cause_confirmed",
		debug_id: session.metadata.id,
		slug,
	});

	return session;
}

/**
 * Record fix applied
 */
export function recordFix(slug: string, fix: string): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	session.context.fix_applied = fix;
	session.metadata.updated = new Date().toISOString();
	saveDebugSession(session);

	return session;
}

/**
 * Record verification and resolve session
 */
export function resolveDebugSession(
	slug: string,
	verification: string,
): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	session.context.verification = verification;
	session.metadata.status = "resolved";
	session.metadata.updated = new Date().toISOString();

	// Save updated content
	const path = getDebugPath(slug);
	const content = `${formatFrontmatter(session.metadata)}

# Debug: ${session.metadata.title}

This file tracks a debugging session using the scientific method.
Update it constantly as you investigate. It survives \`/clear\`.

**Status:** ${session.metadata.status}

${formatContextSections(session.context)}
`;

	// Move to resolved directory
	ensureDebugDirs();
	const resolvedPath = getResolvedDebugPath(slug);

	// Write to resolved location
	writeFileSync(resolvedPath, content, "utf-8");

	// Remove from active directory
	if (existsSync(path)) {
		unlinkSync(path);
	}

	logEvent({
		event: "debug_session_resolved",
		debug_id: session.metadata.id,
		slug,
	});

	return session;
}

/**
 * Abandon a debug session
 */
export function abandonDebugSession(
	slug: string,
	reason?: string,
): DebugSession | null {
	const session = readDebugSession(slug);
	if (!session) return null;

	session.metadata.status = "abandoned";
	session.metadata.updated = new Date().toISOString();

	if (reason) {
		session.context.fix_applied = `Abandoned: ${reason}`;
	}

	// Move to resolved directory (even abandoned sessions are archived)
	const path = getDebugPath(slug);
	const content = `${formatFrontmatter(session.metadata)}

# Debug: ${session.metadata.title}

This file tracks a debugging session using the scientific method.
Update it constantly as you investigate. It survives \`/clear\`.

**Status:** ${session.metadata.status}

${formatContextSections(session.context)}
`;

	ensureDebugDirs();
	const resolvedPath = getResolvedDebugPath(slug);
	writeFileSync(resolvedPath, content, "utf-8");

	if (existsSync(path)) {
		unlinkSync(path);
	}

	logEvent({
		event: "debug_session_abandoned",
		debug_id: session.metadata.id,
		slug,
		reason,
	});

	return session;
}

/**
 * Delete a debug session permanently
 */
export function deleteDebugSession(slug: string): boolean {
	const path = getDebugPath(slug);
	const resolvedPath = getResolvedDebugPath(slug);

	let deleted = false;

	if (existsSync(path)) {
		unlinkSync(path);
		deleted = true;
	}

	if (existsSync(resolvedPath)) {
		unlinkSync(resolvedPath);
		deleted = true;
	}

	if (deleted) {
		logEvent({
			event: "debug_session_deleted",
			slug,
		});
	}

	return deleted;
}

// ============================================
// Context Injection
// ============================================

/**
 * Format a debug session for injection into prompts
 */
export function formatDebugForInjection(session: DebugSession): string {
	const { metadata, context } = session;

	const hypothesesSummary =
		context.hypotheses.length > 0
			? context.hypotheses
					.map((h) => `- [${h.status}] ${h.description}`)
					.join("\n")
			: "(None)";

	const evidenceSummary =
		context.evidence.length > 0
			? context.evidence.map((e) => `- ${e.description}`).join("\n")
			: "(None)";

	return `## Debug Session: ${metadata.title}

**ID:** ${metadata.id} | **Status:** ${metadata.status} | **Updated:** ${metadata.updated}

### Symptoms
${context.symptoms.description || "(Not documented)"}

### Evidence Collected
${evidenceSummary}

### Hypotheses
${hypothesesSummary}

### Root Cause
${context.root_cause || "(Not yet confirmed)"}

### Fix Applied
${context.fix_applied || "(None)"}

### Next Steps
${
	metadata.status === "evidence-gathering"
		? "Collect more evidence and form hypotheses"
		: metadata.status === "hypothesis-testing"
			? "Test remaining hypotheses or confirm root cause"
			: metadata.status === "root-cause-confirmed"
				? "Apply fix and verify"
				: metadata.status === "resolved"
					? "Session complete"
					: "Review and decide next action"
}
`;
}

/**
 * Create a minimal debug context for quick start
 */
export function createMinimalDebugContext(
	description: string,
): DebugContext["symptoms"] {
	return {
		description,
		error_messages: [],
		timeline: new Date().toISOString(),
		reproduction_steps: [],
	};
}
