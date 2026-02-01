/**
 * Unit tests for handoff state module
 *
 * Tests:
 * 1. createHandoff() generates file with 7 context categories
 * 2. readHandoff() parses all 7 categories correctly
 * 3. Round-trip: create → read preserves all data
 * 4. updateHandoff() preserves created timestamp
 * 5. deleteHandoff() removes the file
 * 6. handoffExists() correctly detects files
 * 7. formatHandoffForInjection() produces valid markdown
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	createHandoff,
	createMinimalContext,
	deleteHandoff,
	formatHandoffForInjection,
	getHandoffPath,
	handoffExists,
	readHandoff,
	updateHandoff,
	type HandoffContext,
} from "../../../src/tiller/state/handoff.js";
import type { Run } from "../../../src/tiller/types/index.js";

// Test directory setup
const TEST_ROOT = join(process.cwd(), ".test-handoff");
const TEST_PLAN_DIR = join(TEST_ROOT, "plans", "test", "01-test");
const TEST_PLAN_PATH = join(TEST_PLAN_DIR, "01-01-PLAN.md");

// Mock run for testing
function createMockRun(overrides: Partial<Run> = {}): Run {
	return {
		id: "run-test-123",
		initiative: "test",
		intent: "Test implementation",
		state: "active/executing",
		plan_path: TEST_PLAN_PATH,
		created: "2026-01-18T10:00:00.000Z",
		updated: "2026-01-18T10:30:00.000Z",
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

// Full handoff context for testing
function createFullContext(): HandoffContext {
	return {
		current_state: "Working on implementing the handoff module for session continuity.",
		completed_work: [
			"Created HandoffContext interface with 7 categories",
			"Implemented createHandoff function",
			"Added unit tests for basic functionality",
		],
		remaining_work: [
			"Integrate with pause command",
			"Add prime --full flag support",
			"Create E2E tests",
		],
		decisions_made: [
			{
				decision: "Use YAML frontmatter for metadata",
				rationale: "Consistent with other tiller files and machine-parseable",
			},
			{
				decision: "Store adjacent to PLAN.md",
				rationale: "Easy to find and naturally scoped to the plan",
			},
		],
		blockers: [
			{
				issue: "Need to understand pause command flow",
				status: "resolved",
			},
			{
				issue: "Test infrastructure needs setup",
				status: "workaround",
				workaround: "Using mock filesystem",
			},
		],
		mental_context:
			"The handoff module is key for session continuity. Focusing on making it robust and well-tested before integration.",
		next_action: "Run unit tests and fix any failures",
	};
}

describe("Handoff State Module", () => {
	beforeAll(() => {
		// Clean up any previous test artifacts
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true, force: true });
		}
		// Create test directory structure
		mkdirSync(TEST_PLAN_DIR, { recursive: true });
	});

	afterAll(() => {
		// Clean up
		if (existsSync(TEST_ROOT)) {
			rmSync(TEST_ROOT, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Remove any existing handoff file between tests
		const track = createMockRun();
		const handoffPath = getHandoffPath(track);
		if (existsSync(handoffPath)) {
			rmSync(handoffPath);
		}
	});

	describe("getHandoffPath", () => {
		test("returns path adjacent to PLAN.md", () => {
			const track = createMockRun();
			const path = getHandoffPath(track);

			expect(path).toBe(join(TEST_PLAN_DIR, ".continue-here.md"));
		});

		test("works with different plan paths", () => {
			const track = createMockRun({
				plan_path: "/other/path/02-03-PLAN.md",
			});
			const path = getHandoffPath(track);

			expect(path).toBe("/other/path/.continue-here.md");
		});
	});

	describe("handoffExists", () => {
		test("returns false when file does not exist", () => {
			const track = createMockRun();
			expect(handoffExists(track)).toBe(false);
		});

		test("returns true when file exists", () => {
			const track = createMockRun();
			const context = createMinimalContext("Test state", "Test action");
			createHandoff(track, context);

			expect(handoffExists(track)).toBe(true);
		});
	});

	describe("createHandoff", () => {
		test("creates file with 7 context categories", () => {
			const track = createMockRun();
			const context = createFullContext();

			const path = createHandoff(track, context);

			expect(existsSync(path)).toBe(true);

			const content = readFileSync(path, "utf-8");

			// Verify YAML frontmatter exists
			expect(content).toMatch(/^---\n/);
			expect(content).toContain("phase:");
			expect(content).toContain("plan:");
			expect(content).toContain("run_id:");
			expect(content).toContain("state:");
			expect(content).toContain("created:");
			expect(content).toContain("updated:");

			// Verify all 7 categories are present
			expect(content).toContain("## Current State");
			expect(content).toContain("## Completed Work");
			expect(content).toContain("## Remaining Work");
			expect(content).toContain("## Decisions Made");
			expect(content).toContain("## Blockers");
			expect(content).toContain("## Mental Context");
			expect(content).toContain("## Next Action");
		});

		test("includes context content in generated file", () => {
			const track = createMockRun();
			const context = createFullContext();

			const path = createHandoff(track, context);
			const content = readFileSync(path, "utf-8");

			// Verify content is included
			expect(content).toContain("Working on implementing the handoff module");
			expect(content).toContain("Created HandoffContext interface with 7 categories");
			expect(content).toContain("Integrate with pause command");
			expect(content).toContain("Use YAML frontmatter for metadata");
			expect(content).toContain("Need to understand pause command flow");
			expect(content).toContain("session continuity");
			expect(content).toContain("Run unit tests and fix any failures");
		});

		test("handles empty lists gracefully", () => {
			const track = createMockRun();
			const context: HandoffContext = {
				current_state: "Just started",
				completed_work: [],
				remaining_work: [],
				decisions_made: [],
				blockers: [],
				mental_context: "Fresh start",
				next_action: "Begin work",
			};

			const path = createHandoff(track, context);
			const content = readFileSync(path, "utf-8");

			expect(content).toContain("(No items completed yet)");
			expect(content).toContain("(All work completed)");
			expect(content).toContain("(No significant decisions recorded)");
			expect(content).toContain("(No blockers encountered)");
		});

		test("parses plan ref correctly from path", () => {
			const track = createMockRun();
			const context = createMinimalContext("Test", "Action");

			const path = createHandoff(track, context);
			const content = readFileSync(path, "utf-8");

			// Plan path is 01-01-PLAN.md, so phase should be 01, plan should be 01
			expect(content).toContain("phase: 01");
			expect(content).toContain("plan: 01");
		});
	});

	describe("readHandoff", () => {
		test("returns null when file does not exist", () => {
			const track = createMockRun();
			const result = readHandoff(track);

			expect(result).toBeNull();
		});

		test("parses metadata correctly", () => {
			const track = createMockRun();
			const context = createMinimalContext("Test state", "Test action");
			createHandoff(track, context);

			const result = readHandoff(track);

			expect(result).not.toBeNull();
			expect(result?.metadata.run_id).toBe("run-test-123");
			expect(result?.metadata.state).toBe("active/executing");
			expect(result?.metadata.phase).toBe("01");
			expect(result?.metadata.plan).toBe("01");
		});

		test("parses all 7 context categories", () => {
			const track = createMockRun();
			const context = createFullContext();
			createHandoff(track, context);

			const result = readHandoff(track);

			expect(result).not.toBeNull();

			// Category 1: Current State
			expect(result?.context.current_state).toContain(
				"Working on implementing the handoff module",
			);

			// Category 2: Completed Work
			expect(result?.context.completed_work).toHaveLength(3);
			expect(result?.context.completed_work[0]).toContain(
				"Created HandoffContext interface",
			);

			// Category 3: Remaining Work
			expect(result?.context.remaining_work).toHaveLength(3);
			expect(result?.context.remaining_work[0]).toContain(
				"Integrate with pause command",
			);

			// Category 4: Decisions Made
			expect(result?.context.decisions_made).toHaveLength(2);
			expect(result?.context.decisions_made[0].decision).toContain(
				"Use YAML frontmatter",
			);

			// Category 5: Blockers
			expect(result?.context.blockers).toHaveLength(2);
			expect(result?.context.blockers[0].status).toBe("resolved");

			// Category 6: Mental Context
			expect(result?.context.mental_context).toContain("session continuity");

			// Category 7: Next Action
			expect(result?.context.next_action).toContain(
				"Run unit tests and fix any failures",
			);
		});
	});

	describe("round-trip: create → read", () => {
		test("preserves all data through round-trip", () => {
			const track = createMockRun();
			const original = createFullContext();

			createHandoff(track, original);
			const result = readHandoff(track);

			expect(result).not.toBeNull();

			// Compare all fields
			expect(result?.context.current_state).toBe(original.current_state);
			expect(result?.context.completed_work).toEqual(original.completed_work);
			expect(result?.context.remaining_work).toEqual(original.remaining_work);
			expect(result?.context.mental_context).toBe(original.mental_context);
			expect(result?.context.next_action).toBe(original.next_action);

			// Decisions (structure)
			expect(result?.context.decisions_made).toHaveLength(
				original.decisions_made.length,
			);
			for (let i = 0; i < original.decisions_made.length; i++) {
				expect(result?.context.decisions_made[i].decision).toBe(
					original.decisions_made[i].decision,
				);
			}

			// Blockers (structure)
			expect(result?.context.blockers).toHaveLength(original.blockers.length);
			for (let i = 0; i < original.blockers.length; i++) {
				expect(result?.context.blockers[i].status).toBe(
					original.blockers[i].status,
				);
			}
		});
	});

	describe("updateHandoff", () => {
		test("preserves original created timestamp", () => {
			const track = createMockRun();
			const original = createMinimalContext("Initial state", "Initial action");
			createHandoff(track, original);

			// Wait a moment to ensure timestamp would be different
			const originalFile = readHandoff(track);
			const originalCreated = originalFile?.metadata.created;

			const updated = createMinimalContext("Updated state", "Updated action");
			updateHandoff(track, updated);

			const result = readHandoff(track);
			expect(result?.metadata.created).toBe(originalCreated);
			expect(result?.metadata.updated).not.toBe(originalCreated);
		});

		test("updates context content", () => {
			const track = createMockRun();
			createHandoff(
				track,
				createMinimalContext("Initial state", "Initial action"),
			);

			updateHandoff(
				track,
				createMinimalContext("Updated state", "Updated action"),
			);

			const result = readHandoff(track);
			expect(result?.context.current_state).toBe("Updated state");
			expect(result?.context.next_action).toBe("Updated action");
		});
	});

	describe("deleteHandoff", () => {
		test("removes the file", () => {
			const track = createMockRun();
			createHandoff(track, createMinimalContext("Test", "Action"));

			expect(handoffExists(track)).toBe(true);

			const deleted = deleteHandoff(track);

			expect(deleted).toBe(true);
			expect(handoffExists(track)).toBe(false);
		});

		test("returns false when file does not exist", () => {
			const track = createMockRun();
			const deleted = deleteHandoff(track);

			expect(deleted).toBe(false);
		});
	});

	describe("createMinimalContext", () => {
		test("creates context with sensible defaults", () => {
			const context = createMinimalContext("Current work", "Next step");

			expect(context.current_state).toBe("Current work");
			expect(context.next_action).toBe("Next step");
			expect(context.completed_work).toEqual([]);
			expect(context.remaining_work).toEqual([]);
			expect(context.decisions_made).toEqual([]);
			expect(context.blockers).toEqual([]);
			expect(context.mental_context).toContain("Session paused");
		});
	});

	describe("formatHandoffForInjection", () => {
		test("produces valid markdown for prompt injection", () => {
			const track = createMockRun();
			const context = createFullContext();
			createHandoff(track, context);

			const handoff = readHandoff(track);
			expect(handoff).not.toBeNull();

			const formatted = formatHandoffForInjection(handoff!);

			// Should have headers
			expect(formatted).toContain("## Session Context");
			expect(formatted).toContain("### Where We Left Off");
			expect(formatted).toContain("### Completed Work");
			expect(formatted).toContain("### Remaining Work");
			expect(formatted).toContain("### Key Decisions");
			expect(formatted).toContain("### Blockers");
			expect(formatted).toContain("### Mental Context");
			expect(formatted).toContain("### Next Action");

			// Should have metadata summary
			expect(formatted).toContain("**Plan:**");
			expect(formatted).toContain("**State:**");
		});

		test("handles empty context gracefully", () => {
			const track = createMockRun();
			const context: HandoffContext = {
				current_state: "Minimal",
				completed_work: [],
				remaining_work: [],
				decisions_made: [],
				blockers: [],
				mental_context: "None",
				next_action: "Start",
			};
			createHandoff(track, context);

			const handoff = readHandoff(track);
			const formatted = formatHandoffForInjection(handoff!);

			expect(formatted).toContain("(None)");
		});
	});
});
