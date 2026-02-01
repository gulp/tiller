/**
 * Unit tests for debug state module
 *
 * Tests:
 * 1. createDebugSession() generates file with 6 context categories
 * 2. readDebugSession() parses all categories correctly
 * 3. Round-trip: create -> read preserves all data
 * 4. listDebugSessions() returns active sessions
 * 5. Evidence and hypothesis management
 * 6. Status updates and workflow transitions
 * 7. resolveDebugSession() moves to resolved directory
 * 8. abandonDebugSession() archives with reason
 * 9. formatDebugForInjection() produces valid markdown
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	abandonDebugSession,
	addDebugEvidence,
	addDebugHypothesis,
	confirmRootCause,
	createDebugSession,
	deleteDebugSession,
	formatDebugForInjection,
	generateSlug,
	getDebugDir,
	getDebugPath,
	getResolvedDebugDir,
	listDebugSessions,
	readDebugSession,
	recordFix,
	resolveDebugSession,
	saveDebugSession,
	updateDebugStatus,
	updateHypothesis,
} from "../../../src/tiller/state/debug.js";

// Test directory setup - use project's .planning/debug for tests
const TEST_ROOT = join(process.cwd(), ".planning");
const DEBUG_DIR = join(TEST_ROOT, "debug");
const RESOLVED_DIR = join(DEBUG_DIR, "resolved");

describe("Debug State Module", () => {
	beforeAll(() => {
		// Create test directory structure
		mkdirSync(DEBUG_DIR, { recursive: true });
		mkdirSync(RESOLVED_DIR, { recursive: true });
	});

	afterAll(() => {
		// Clean up test files but not the directories
		const debugFiles = [
			"test-session.md",
			"my-test-bug.md",
			"complex-session.md",
			"evidence-test.md",
			"hypothesis-test.md",
			"workflow-test.md",
			"resolve-test.md",
			"abandon-test.md",
			"injection-test.md",
		];

		for (const file of debugFiles) {
			const path = join(DEBUG_DIR, file);
			if (existsSync(path)) {
				rmSync(path);
			}
			const resolvedPath = join(RESOLVED_DIR, file);
			if (existsSync(resolvedPath)) {
				rmSync(resolvedPath);
			}
		}
	});

	beforeEach(() => {
		// Remove test files between tests
		const testSlugs = [
			"test-session",
			"my-test-bug",
			"complex-session",
			"evidence-test",
			"hypothesis-test",
			"workflow-test",
			"resolve-test",
			"abandon-test",
			"injection-test",
		];

		for (const slug of testSlugs) {
			deleteDebugSession(slug);
		}
	});

	describe("generateSlug", () => {
		test("converts title to lowercase slug", () => {
			expect(generateSlug("My Test Bug")).toBe("my-test-bug");
		});

		test("replaces non-alphanumeric with dashes", () => {
			expect(generateSlug("Error: Something went wrong!")).toBe(
				"error-something-went-wrong",
			);
		});

		test("truncates to 50 characters", () => {
			const longTitle =
				"This is a very long title that should be truncated to fifty characters maximum";
			expect(generateSlug(longTitle).length).toBeLessThanOrEqual(50);
		});

		test("removes leading and trailing dashes", () => {
			expect(generateSlug("---test---")).toBe("test");
		});
	});

	describe("getDebugPath / getDebugDir", () => {
		test("returns path in .planning/debug directory", () => {
			const path = getDebugPath("test-session");
			expect(path).toContain(".planning/debug");
			expect(path).toContain("test-session.md");
		});

		test("getDebugDir returns the debug directory path", () => {
			const dir = getDebugDir();
			expect(dir).toContain(".planning/debug");
		});

		test("getResolvedDebugDir returns the resolved directory path", () => {
			const dir = getResolvedDebugDir();
			expect(dir).toContain(".planning/debug/resolved");
		});
	});

	describe("createDebugSession", () => {
		test("creates file with correct structure", () => {
			const session = createDebugSession("Test Session", "Something broke");

			expect(session.metadata.title).toBe("Test Session");
			expect(session.metadata.slug).toBe("test-session");
			expect(session.metadata.status).toBe("evidence-gathering");
			expect(session.context.symptoms.description).toBe("Something broke");

			const path = getDebugPath("test-session");
			expect(existsSync(path)).toBe(true);
		});

		test("generates unique ID", () => {
			const session1 = createDebugSession("Test Session", "Bug 1");
			const session2 = createDebugSession("Test Session 2", "Bug 2");

			expect(session1.metadata.id).not.toBe(session2.metadata.id);

			// Cleanup
			deleteDebugSession("test-session");
			deleteDebugSession("test-session-2");
		});

		test("links to track when provided", () => {
			const session = createDebugSession(
				"My Test Bug",
				"Description",
				"track-123",
			);

			expect(session.metadata.run_id).toBe("track-123");
		});

		test("creates file with 6 context categories", () => {
			createDebugSession("My Test Bug", "Test symptoms");

			const path = getDebugPath("my-test-bug");
			const content = readFileSync(path, "utf-8");

			// Verify YAML frontmatter
			expect(content).toMatch(/^---\n/);
			expect(content).toContain("id:");
			expect(content).toContain("slug:");
			expect(content).toContain("title:");
			expect(content).toContain("status:");
			expect(content).toContain("created:");
			expect(content).toContain("updated:");

			// Verify all 6 categories
			expect(content).toContain("## Symptoms");
			expect(content).toContain("## Evidence");
			expect(content).toContain("## Hypotheses");
			expect(content).toContain("## Root Cause");
			expect(content).toContain("## Fix Applied");
			expect(content).toContain("## Verification");
		});
	});

	describe("readDebugSession", () => {
		test("returns null when session does not exist", () => {
			const result = readDebugSession("nonexistent");
			expect(result).toBeNull();
		});

		test("parses metadata correctly", () => {
			createDebugSession("Test Session", "Test symptoms");

			const result = readDebugSession("test-session");

			expect(result).not.toBeNull();
			expect(result?.metadata.title).toBe("Test Session");
			expect(result?.metadata.slug).toBe("test-session");
			expect(result?.metadata.status).toBe("evidence-gathering");
		});

		test("parses symptoms correctly", () => {
			const session = createDebugSession("Test Session", "Test description");
			session.context.symptoms.error_messages = ["Error: test error"];
			session.context.symptoms.timeline = "Started yesterday";
			session.context.symptoms.reproduction_steps = [
				"Step 1",
				"Step 2",
				"Step 3",
			];
			saveDebugSession(session);

			const result = readDebugSession("test-session");

			expect(result?.context.symptoms.description).toBe("Test description");
			expect(result?.context.symptoms.error_messages).toContain(
				"Error: test error",
			);
			expect(result?.context.symptoms.timeline).toContain("yesterday");
			expect(result?.context.symptoms.reproduction_steps).toHaveLength(3);
		});
	});

	describe("round-trip: create -> read", () => {
		test("preserves metadata through round-trip", () => {
			const original = createDebugSession(
				"Complex Session",
				"Complex issue",
				"track-abc",
			);

			const result = readDebugSession("complex-session");

			expect(result?.metadata.title).toBe(original.metadata.title);
			expect(result?.metadata.slug).toBe(original.metadata.slug);
			expect(result?.metadata.run_id).toBe(original.metadata.run_id);
			expect(result?.metadata.status).toBe(original.metadata.status);
		});

		test("preserves context through round-trip", () => {
			const session = createDebugSession("Complex Session", "Test");
			session.context.symptoms.error_messages = ["Error 1", "Error 2"];
			session.context.evidence = [
				{
					description: "Found error in log",
					source: "server.log",
					found_at: new Date().toISOString(),
				},
			];
			session.context.hypotheses = [
				{
					description: "Database connection issue",
					status: "pending",
				},
			];
			saveDebugSession(session);

			const result = readDebugSession("complex-session");

			expect(result?.context.evidence).toHaveLength(1);
			expect(result?.context.evidence[0].description).toBe("Found error in log");
			expect(result?.context.hypotheses).toHaveLength(1);
			expect(result?.context.hypotheses[0].description).toBe(
				"Database connection issue",
			);
		});
	});

	describe("listDebugSessions", () => {
		test("returns empty array when no sessions", () => {
			// Ensure clean state
			const sessions = listDebugSessions().filter(
				(s) =>
					s.metadata.slug === "test-session" ||
					s.metadata.slug === "my-test-bug",
			);

			// Clean up any existing test sessions
			for (const s of sessions) {
				deleteDebugSession(s.metadata.slug);
			}
		});

		test("returns active sessions sorted by update time", () => {
			createDebugSession("Test Session", "First");
			// Small delay to ensure different timestamps
			createDebugSession("My Test Bug", "Second");

			const sessions = listDebugSessions();
			const testSessions = sessions.filter(
				(s) =>
					s.metadata.slug === "test-session" ||
					s.metadata.slug === "my-test-bug",
			);

			expect(testSessions.length).toBeGreaterThanOrEqual(2);
			// Most recent first
			expect(
				new Date(testSessions[0].metadata.updated).getTime(),
			).toBeGreaterThanOrEqual(
				new Date(testSessions[1].metadata.updated).getTime(),
			);
		});
	});

	describe("addDebugEvidence", () => {
		test("adds evidence to session", () => {
			createDebugSession("Evidence Test", "Testing evidence");

			const result = addDebugEvidence("evidence-test", {
				description: "Stack trace shows null pointer",
				source: "error.log:42",
			});

			expect(result?.context.evidence).toHaveLength(1);
			expect(result?.context.evidence[0].description).toBe(
				"Stack trace shows null pointer",
			);
			expect(result?.context.evidence[0].source).toBe("error.log:42");
			expect(result?.context.evidence[0].found_at).toBeTruthy();
		});

		test("returns null for nonexistent session", () => {
			const result = addDebugEvidence("nonexistent", {
				description: "Test",
				source: "test",
			});

			expect(result).toBeNull();
		});
	});

	describe("addDebugHypothesis", () => {
		test("adds hypothesis to session", () => {
			createDebugSession("Hypothesis Test", "Testing hypotheses");

			const result = addDebugHypothesis(
				"hypothesis-test",
				"Memory leak in worker thread",
			);

			expect(result?.context.hypotheses).toHaveLength(1);
			expect(result?.context.hypotheses[0].description).toBe(
				"Memory leak in worker thread",
			);
			expect(result?.context.hypotheses[0].status).toBe("pending");
		});
	});

	describe("updateHypothesis", () => {
		test("updates hypothesis test result", () => {
			createDebugSession("Hypothesis Test", "Testing");
			addDebugHypothesis("hypothesis-test", "Test hypothesis");

			const result = updateHypothesis("hypothesis-test", 0, {
				test_performed: "Ran memory profiler",
				test_result: "No leak detected",
				status: "eliminated",
			});

			expect(result?.context.hypotheses[0].status).toBe("eliminated");
			expect(result?.context.hypotheses[0].test_performed).toBe(
				"Ran memory profiler",
			);
			expect(result?.context.hypotheses[0].test_result).toBe("No leak detected");
			expect(result?.context.hypotheses[0].tested_at).toBeTruthy();
		});

		test("returns null for invalid index", () => {
			createDebugSession("Hypothesis Test", "Testing");

			const result = updateHypothesis("hypothesis-test", 5, {
				status: "confirmed",
			});

			expect(result).toBeNull();
		});
	});

	describe("updateDebugStatus", () => {
		test("updates session status", () => {
			createDebugSession("Workflow Test", "Testing workflow");

			const result = updateDebugStatus("workflow-test", "hypothesis-testing");

			expect(result?.metadata.status).toBe("hypothesis-testing");
		});
	});

	describe("confirmRootCause", () => {
		test("confirms root cause and updates status", () => {
			createDebugSession("Workflow Test", "Testing");

			const result = confirmRootCause(
				"workflow-test",
				"Race condition in async handler",
			);

			expect(result?.context.root_cause).toBe(
				"Race condition in async handler",
			);
			expect(result?.metadata.status).toBe("root-cause-confirmed");
		});
	});

	describe("recordFix", () => {
		test("records fix applied", () => {
			createDebugSession("Workflow Test", "Testing");

			const result = recordFix(
				"workflow-test",
				"Added mutex lock around critical section",
			);

			expect(result?.context.fix_applied).toBe(
				"Added mutex lock around critical section",
			);
		});
	});

	describe("resolveDebugSession", () => {
		test("moves session to resolved directory", () => {
			createDebugSession("Resolve Test", "Testing resolution");

			const result = resolveDebugSession(
				"resolve-test",
				"Verified fix works in production",
			);

			expect(result?.metadata.status).toBe("resolved");
			expect(result?.context.verification).toBe(
				"Verified fix works in production",
			);

			// File should be in resolved directory
			const activePath = getDebugPath("resolve-test");
			const resolvedPath = join(getResolvedDebugDir(), "resolve-test.md");

			expect(existsSync(activePath)).toBe(false);
			expect(existsSync(resolvedPath)).toBe(true);
		});
	});

	describe("abandonDebugSession", () => {
		test("archives session with reason", () => {
			createDebugSession("Abandon Test", "Testing abandonment");

			const result = abandonDebugSession(
				"abandon-test",
				"Issue no longer reproducible",
			);

			expect(result?.metadata.status).toBe("abandoned");
			expect(result?.context.fix_applied).toContain(
				"Issue no longer reproducible",
			);

			// File should be in resolved directory
			const activePath = getDebugPath("abandon-test");
			const resolvedPath = join(getResolvedDebugDir(), "abandon-test.md");

			expect(existsSync(activePath)).toBe(false);
			expect(existsSync(resolvedPath)).toBe(true);
		});
	});

	describe("formatDebugForInjection", () => {
		test("produces valid markdown for prompt injection", () => {
			const session = createDebugSession("Injection Test", "Test symptoms");
			session.context.evidence = [
				{
					description: "Found error",
					source: "log.txt",
					found_at: new Date().toISOString(),
				},
			];
			session.context.hypotheses = [
				{ description: "Test hypothesis", status: "pending" },
			];
			saveDebugSession(session);

			const result = readDebugSession("injection-test");
			const formatted = formatDebugForInjection(result!);

			expect(formatted).toContain("## Debug Session: Injection Test");
			expect(formatted).toContain("**ID:**");
			expect(formatted).toContain("**Status:**");
			expect(formatted).toContain("### Symptoms");
			expect(formatted).toContain("### Evidence Collected");
			expect(formatted).toContain("### Hypotheses");
			expect(formatted).toContain("### Root Cause");
			expect(formatted).toContain("### Next Steps");
		});

		test("handles empty context gracefully", () => {
			createDebugSession("Injection Test", "Minimal");

			const result = readDebugSession("injection-test");
			const formatted = formatDebugForInjection(result!);

			expect(formatted).toContain("(None)");
			expect(formatted).toContain("(Not yet confirmed)");
		});
	});

	describe("deleteDebugSession", () => {
		test("removes session from both directories", () => {
			createDebugSession("Test Session", "Test");
			const path = getDebugPath("test-session");
			expect(existsSync(path)).toBe(true);

			const deleted = deleteDebugSession("test-session");

			expect(deleted).toBe(true);
			expect(existsSync(path)).toBe(false);
		});

		test("returns false for nonexistent session", () => {
			const deleted = deleteDebugSession("nonexistent-session-xyz");
			expect(deleted).toBe(false);
		});
	});
});
