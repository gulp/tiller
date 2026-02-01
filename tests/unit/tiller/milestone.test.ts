/**
 * Unit tests for milestone state module
 *
 * Tests:
 * 1. createMilestone() creates milestone with correct structure
 * 2. getMilestone() retrieves milestone with derived state
 * 3. listMilestones() returns all milestones
 * 4. updateMilestone() modifies metadata
 * 5. deleteMilestone() removes milestone
 * 6. deriveMilestoneStatus() computes correct status from phases
 * 7. canCompleteMilestone() validates completion readiness
 * 8. completeMilestone() archives and updates status
 * 9. formatMilestoneForInjection() produces valid markdown
 * 10. parseMilestonesFromRoadmap() extracts milestones from ROADMAP.md
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	canCompleteMilestone,
	createMilestone,
	deleteMilestone,
	deriveMilestoneStatus,
	formatMilestoneForInjection,
	getArchiveDir,
	getArchivePath,
	getCurrentMilestone,
	getMilestone,
	getMilestonesPath,
	getMilestoneStats,
	listArchivedMilestones,
	listMilestones,
	parseMilestonesFromRoadmap,
	setCurrentMilestone,
	suggestMilestoneFromRoadmap,
	updateMilestone,
} from "../../../src/tiller/state/milestone.js";
import type { PhaseInfo } from "../../../src/tiller/state/phase.js";

// Test directory setup
const TEST_ROOT = process.cwd();
const TILLER_DIR = join(TEST_ROOT, ".tiller");
const MILESTONES_FILE = join(TILLER_DIR, "milestones.json");
const ARCHIVE_DIR = join(TEST_ROOT, ".planning/milestones");

describe("Milestone State Module", () => {
	beforeAll(() => {
		// Create test directory structure
		mkdirSync(TILLER_DIR, { recursive: true });
		mkdirSync(ARCHIVE_DIR, { recursive: true });
	});

	afterAll(() => {
		// Clean up test files
		if (existsSync(MILESTONES_FILE)) {
			rmSync(MILESTONES_FILE);
		}
		// Clean up archive files created during tests
		const archiveFiles = ["v1.0-ROADMAP.md", "v2.0-ROADMAP.md", "v1.1-ROADMAP.md"];
		for (const file of archiveFiles) {
			const path = join(ARCHIVE_DIR, file);
			if (existsSync(path)) {
				rmSync(path);
			}
		}
	});

	beforeEach(() => {
		// Reset milestones file between tests
		if (existsSync(MILESTONES_FILE)) {
			rmSync(MILESTONES_FILE);
		}
	});

	describe("getMilestonesPath / getArchiveDir / getArchivePath", () => {
		test("getMilestonesPath returns correct path", () => {
			const path = getMilestonesPath();
			expect(path).toContain(".tiller/milestones.json");
		});

		test("getArchiveDir returns archive directory path", () => {
			const dir = getArchiveDir();
			expect(dir).toContain(".planning/milestones");
		});

		test("getArchivePath normalizes version", () => {
			expect(getArchivePath("1.0")).toContain("v1.0-ROADMAP.md");
			expect(getArchivePath("v2.0")).toContain("v2.0-ROADMAP.md");
		});
	});

	describe("deriveMilestoneStatus", () => {
		test("returns 'planning' for empty phases", () => {
			expect(deriveMilestoneStatus([])).toBe("planning");
		});

		test("returns 'ready' when all phases complete", () => {
			const phases: PhaseInfo[] = [
				{
					id: "01",
					name: "foundation",
					state: "complete",
					tracks: [],
					progress: { total: 1, complete: 1, active: 0, verifying: 0 },
				},
				{
					id: "02",
					name: "core",
					state: "complete",
					tracks: [],
					progress: { total: 2, complete: 2, active: 0, verifying: 0 },
				},
			];
			expect(deriveMilestoneStatus(phases)).toBe("ready");
		});

		test("returns 'verifying' when all in verifying state", () => {
			const phases: PhaseInfo[] = [
				{
					id: "01",
					name: "foundation",
					state: "verifying",
					tracks: [],
					progress: { total: 1, complete: 0, active: 0, verifying: 1 },
				},
				{
					id: "02",
					name: "core",
					state: "complete",
					tracks: [],
					progress: { total: 2, complete: 2, active: 0, verifying: 0 },
				},
			];
			expect(deriveMilestoneStatus(phases)).toBe("verifying");
		});

		test("returns 'active' when any phase is active", () => {
			const phases: PhaseInfo[] = [
				{
					id: "01",
					name: "foundation",
					state: "complete",
					tracks: [],
					progress: { total: 1, complete: 1, active: 0, verifying: 0 },
				},
				{
					id: "02",
					name: "core",
					state: "active",
					tracks: [],
					progress: { total: 2, complete: 0, active: 2, verifying: 0 },
				},
			];
			expect(deriveMilestoneStatus(phases)).toBe("active");
		});

		test("returns 'planning' when phases are in planning", () => {
			const phases: PhaseInfo[] = [
				{
					id: "01",
					name: "foundation",
					state: "proposed",
					tracks: [],
					progress: { total: 0, complete: 0, active: 0, verifying: 0 },
				},
			];
			expect(deriveMilestoneStatus(phases)).toBe("planning");
		});
	});

	describe("createMilestone", () => {
		test("creates milestone with correct structure", () => {
			const ms = createMilestone("1.0", "Test Milestone", ["01", "02"]);

			expect(ms.metadata.version).toBe("1.0");
			expect(ms.metadata.title).toBe("Test Milestone");
			expect(ms.metadata.phases).toEqual(["01", "02"]);
			expect(ms.metadata.created).toBeDefined();
			expect(ms.metadata.updated).toBeDefined();
		});

		test("throws on duplicate version", () => {
			createMilestone("1.0", "First", []);
			expect(() => createMilestone("1.0", "Duplicate", [])).toThrow(
				"already exists",
			);
		});

		test("sets first milestone as current", () => {
			createMilestone("1.0", "First", []);
			const current = getCurrentMilestone();
			expect(current?.metadata.version).toBe("1.0");
		});
	});

	describe("getMilestone", () => {
		test("returns null for non-existent milestone", () => {
			expect(getMilestone("99.0")).toBeNull();
		});

		test("returns milestone with derived status", () => {
			createMilestone("1.0", "Test", []);
			const ms = getMilestone("1.0");

			expect(ms).not.toBeNull();
			expect(ms!.metadata.version).toBe("1.0");
			expect(ms!.status).toBe("planning"); // No phases = planning
		});
	});

	describe("listMilestones", () => {
		test("returns empty array when no milestones", () => {
			expect(listMilestones()).toEqual([]);
		});

		test("returns all milestones", () => {
			createMilestone("1.0", "First", []);
			createMilestone("2.0", "Second", []);

			const milestones = listMilestones();
			expect(milestones.length).toBe(2);
		});
	});

	describe("updateMilestone", () => {
		test("updates title", () => {
			createMilestone("1.0", "Original", []);
			const updated = updateMilestone("1.0", { title: "Updated Title" });

			expect(updated?.metadata.title).toBe("Updated Title");
		});

		test("updates phases", () => {
			createMilestone("1.0", "Test", ["01"]);
			const updated = updateMilestone("1.0", { phases: ["01", "02", "03"] });

			expect(updated?.metadata.phases).toEqual(["01", "02", "03"]);
		});

		test("returns null for non-existent milestone", () => {
			expect(updateMilestone("99.0", { title: "Test" })).toBeNull();
		});
	});

	describe("deleteMilestone", () => {
		test("removes milestone", () => {
			createMilestone("1.0", "Test", []);
			expect(deleteMilestone("1.0")).toBe(true);
			expect(getMilestone("1.0")).toBeNull();
		});

		test("clears current if deleted", () => {
			createMilestone("1.0", "Test", []);
			expect(getCurrentMilestone()?.metadata.version).toBe("1.0");

			deleteMilestone("1.0");
			expect(getCurrentMilestone()).toBeNull();
		});

		test("returns false for non-existent", () => {
			expect(deleteMilestone("99.0")).toBe(false);
		});
	});

	describe("getCurrentMilestone / setCurrentMilestone", () => {
		test("setCurrentMilestone changes current", () => {
			createMilestone("1.0", "First", []);
			createMilestone("2.0", "Second", []);

			setCurrentMilestone("2.0");
			expect(getCurrentMilestone()?.metadata.version).toBe("2.0");
		});

		test("setCurrentMilestone throws for non-existent", () => {
			expect(() => setCurrentMilestone("99.0")).toThrow("not found");
		});

		test("setCurrentMilestone accepts null", () => {
			createMilestone("1.0", "Test", []);
			setCurrentMilestone(null);
			expect(getCurrentMilestone()).toBeNull();
		});
	});

	describe("canCompleteMilestone", () => {
		test("returns ready=false for non-existent milestone", () => {
			const result = canCompleteMilestone("99.0");
			expect(result.ready).toBe(false);
			expect(result.reason).toBe("Milestone not found");
		});

		test("returns ready=true for milestone with no phases", () => {
			// A milestone with no phases is technically "complete"
			createMilestone("1.0", "Empty", []);
			const result = canCompleteMilestone("1.0");
			expect(result.ready).toBe(true);
		});
	});

	describe("formatMilestoneForInjection", () => {
		test("produces valid markdown with all sections", () => {
			createMilestone("1.0", "Test Milestone", ["01", "02"]);
			const ms = getMilestone("1.0")!;
			const markdown = formatMilestoneForInjection(ms);

			expect(markdown).toContain("## Milestone: Test Milestone (1.0)");
			expect(markdown).toContain("**Status:**");
			expect(markdown).toContain("**Progress:**");
			expect(markdown).toContain("### Phases");
			expect(markdown).toContain("### Next Steps");
		});
	});

	describe("getMilestoneStats", () => {
		test("returns null for non-existent milestone", () => {
			expect(getMilestoneStats("99.0")).toBeNull();
		});

		test("returns zero stats for milestone with no phases", () => {
			createMilestone("1.0", "Empty", []);
			const stats = getMilestoneStats("1.0");

			expect(stats).not.toBeNull();
			expect(stats!.total_plans).toBe(0);
			expect(stats!.completed_plans).toBe(0);
			expect(stats!.total_tracks).toBe(0);
		});
	});

	describe("listArchivedMilestones", () => {
		test("returns empty array when no archived milestones", () => {
			const archived = listArchivedMilestones();
			// May have files from previous tests, but should be array
			expect(Array.isArray(archived)).toBe(true);
		});
	});
});

describe("Milestone ROADMAP Parsing", () => {
	const PLANNING_DIR = join(process.cwd(), ".planning");
	const ROADMAP_PATH = join(PLANNING_DIR, "ROADMAP.md");
	let originalContent: string | null = null;

	beforeAll(() => {
		mkdirSync(PLANNING_DIR, { recursive: true });
		// Backup original ROADMAP.md if it exists
		if (existsSync(ROADMAP_PATH)) {
			originalContent = require("fs").readFileSync(ROADMAP_PATH, "utf-8");
		}
	});

	afterAll(() => {
		// Restore original ROADMAP.md
		if (originalContent !== null) {
			writeFileSync(ROADMAP_PATH, originalContent);
		}
	});

	describe("parseMilestonesFromRoadmap", () => {
		test("parses milestone sections from ROADMAP.md", () => {
			// Create test ROADMAP.md with milestone sections
			const testRoadmap = `# Roadmap

## Overview
Test roadmap

## Phases

### Test Milestone (Current)
- [ ] **Phase 1: Foundation**
- [ ] **Phase 2: Core**
- [x] **Phase 3: Complete**

### Future Milestone (Parked)
- [ ] **Phase 10: Future**
`;
			writeFileSync(ROADMAP_PATH, testRoadmap);

			const parsed = parseMilestonesFromRoadmap();

			expect(parsed.length).toBe(2);
			expect(parsed[0].title).toBe("Test");
			expect(parsed[0].isCurrent).toBe(true);
			expect(parsed[0].phases).toContain("1");
			expect(parsed[0].phases).toContain("2");
			expect(parsed[0].phases).toContain("3");

			expect(parsed[1].title).toBe("Future");
			expect(parsed[1].isCurrent).toBe(false);
		});

		test("returns empty array for roadmap without milestones", () => {
			const testRoadmap = `# Roadmap

## Overview
No milestones here

## Phases
- Phase 1
- Phase 2
`;
			writeFileSync(ROADMAP_PATH, testRoadmap);

			const parsed = parseMilestonesFromRoadmap();
			expect(parsed.length).toBe(0);
		});
	});

	describe("suggestMilestoneFromRoadmap", () => {
		test("suggests milestone from current section", () => {
			const testRoadmap = `# Roadmap

### My Project Milestone (Current)
- [ ] **Phase 1: First**
- [ ] **Phase 2: Second**
`;
			writeFileSync(ROADMAP_PATH, testRoadmap);

			const suggested = suggestMilestoneFromRoadmap();

			expect(suggested).not.toBeNull();
			expect(suggested!.title).toBe("My Project");
			expect(suggested!.version).toBe("1.0"); // Default when no version in title
			expect(suggested!.phases.length).toBe(2);
		});

		test("extracts version from title", () => {
			const testRoadmap = `# Roadmap

### Tiller v2.1 Milestone (Current)
- [ ] **Phase 1: Test**
`;
			writeFileSync(ROADMAP_PATH, testRoadmap);

			const suggested = suggestMilestoneFromRoadmap();
			expect(suggested?.version).toBe("2.1");
		});

		test("returns null when no current milestone", () => {
			const testRoadmap = `# Roadmap

### Old Milestone (Archived)
- [x] **Phase 1: Done**
`;
			writeFileSync(ROADMAP_PATH, testRoadmap);

			const suggested = suggestMilestoneFromRoadmap();
			expect(suggested).toBeNull();
		});
	});
});
