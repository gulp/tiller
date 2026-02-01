/**
 * Tests for ROADMAP.md file manipulation
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	generatePhaseSection,
	getRoadmapContent,
	insertPhaseSection,
	parseRoadmapSections,
	removePhaseSection,
	renumberRoadmapReferences,
	updatePhaseChecklist,
	writeRoadmapContent,
} from "../../../src/tiller/state/roadmap-file.js";

// Work in a temp directory to avoid affecting real files
const TEST_DIR = join(process.cwd(), ".test-roadmap");
const ROADMAP_PATH = ".planning/ROADMAP.md";

describe("roadmap-file", () => {
	const originalCwd = process.cwd();

	beforeEach(() => {
		// Create test directory and switch to it
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
		mkdirSync(TEST_DIR, { recursive: true });
		process.chdir(TEST_DIR);
		mkdirSync(".planning", { recursive: true });
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true });
		}
	});

	describe("parseRoadmapSections", () => {
		test("returns empty array when ROADMAP.md does not exist", () => {
			const sections = parseRoadmapSections();
			expect(sections).toEqual([]);
		});

		test("parses single phase section", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Initial Setup
**Goal**: Set up project structure
**Depends on**: None

Plans:
- [ ] 01-01: First plan
`,
			);

			const sections = parseRoadmapSections();
			expect(sections).toHaveLength(1);
			expect(sections[0].id).toBe("01");
			expect(sections[0].name).toBe("Initial Setup");
			expect(sections[0].inserted).toBe(false);
		});

		test("parses multiple phase sections", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Initial Setup
Content for phase 1

### Phase 02: Implementation
Content for phase 2

### Phase 03: Testing
Content for phase 3
`,
			);

			const sections = parseRoadmapSections();
			expect(sections).toHaveLength(3);
			expect(sections[0].id).toBe("01");
			expect(sections[1].id).toBe("02");
			expect(sections[2].id).toBe("03");
		});

		test("parses decimal phase IDs", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 3.1: Inserted Work
Urgent fix content

### Phase 4: Regular Phase
Content
`,
			);

			const sections = parseRoadmapSections();
			expect(sections).toHaveLength(2);
			expect(sections[0].id).toBe("3.1");
			expect(sections[1].id).toBe("4");
		});

		test("detects (INSERTED) marker", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 3.1: Urgent Fix (INSERTED)
Inserted content

### Phase 4: Regular
Regular content
`,
			);

			const sections = parseRoadmapSections();
			expect(sections[0].inserted).toBe(true);
			expect(sections[1].inserted).toBe(false);
		});

		test("captures section content correctly", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Setup
**Goal**: Initialize project
**Depends on**: None

Plans:
- [ ] 01-01: First task
- [ ] 01-02: Second task

### Phase 02: Build
Second phase content
`,
			);

			const sections = parseRoadmapSections();
			expect(sections[0].content).toContain("**Goal**: Initialize project");
			expect(sections[0].content).toContain("01-01: First task");
			expect(sections[0].content).not.toContain("Second phase content");
		});
	});

	describe("generatePhaseSection", () => {
		test("generates basic phase section", () => {
			const section = generatePhaseSection("03", "New Feature", "02");

			expect(section).toContain("### Phase 03: New Feature");
			expect(section).toContain("**Depends on**: Phase 02");
			expect(section).toContain("- [ ] 03-01:");
		});

		test("adds (INSERTED) marker when specified", () => {
			const section = generatePhaseSection("03.1", "Urgent Fix", "03", {
				inserted: true,
			});

			expect(section).toContain("### Phase 03.1: Urgent Fix (INSERTED)");
		});

		test("uses custom goal when provided", () => {
			const section = generatePhaseSection("04", "Testing", "03", {
				goal: "Achieve 80% code coverage",
			});

			expect(section).toContain("**Goal**: Achieve 80% code coverage");
		});
	});

	describe("insertPhaseSection", () => {
		test("throws when ROADMAP.md does not exist", () => {
			expect(() => insertPhaseSection("01", "content")).toThrow(
				"ROADMAP.md not found",
			);
		});

		test("throws when target phase not found", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Setup
Content
`,
			);

			expect(() => insertPhaseSection("99", "content")).toThrow(
				"Phase 99 not found",
			);
		});

		test("inserts section after target phase", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Setup
Setup content

### Phase 02: Build
Build content
`,
			);

			const newSection = generatePhaseSection("01.5", "Inserted", "01", {
				inserted: true,
			});
			insertPhaseSection("01", newSection);

			const content = getRoadmapContent();
			const phase01Index = content.indexOf("### Phase 01:");
			const phase015Index = content.indexOf("### Phase 01.5:");
			const phase02Index = content.indexOf("### Phase 02:");

			expect(phase015Index).toBeGreaterThan(phase01Index);
			expect(phase015Index).toBeLessThan(phase02Index);
		});
	});

	describe("removePhaseSection", () => {
		test("throws when ROADMAP.md does not exist", () => {
			expect(() => removePhaseSection("01")).toThrow("ROADMAP.md not found");
		});

		test("throws when phase not found", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Setup
Content
`,
			);

			expect(() => removePhaseSection("99")).toThrow("Phase 99 not found");
		});

		test("removes specified phase section", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Setup
Setup content

### Phase 02: Build
Build content

### Phase 03: Test
Test content
`,
			);

			removePhaseSection("02");

			const content = getRoadmapContent();
			expect(content).toContain("### Phase 01:");
			expect(content).not.toContain("### Phase 02:");
			expect(content).toContain("### Phase 03:");
		});

		test("cleans up extra newlines after removal", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 01: Setup
Content


### Phase 02: Middle
Middle content



### Phase 03: End
End content
`,
			);

			removePhaseSection("02");

			const content = getRoadmapContent();
			// Should not have more than 2 consecutive newlines
			expect(content).not.toMatch(/\n{3,}/);
		});
	});

	describe("renumberRoadmapReferences", () => {
		test("does nothing when ROADMAP.md does not exist", () => {
			// Should not throw
			renumberRoadmapReferences(new Map([["08", "07"]]));
		});

		test("updates phase headers", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 08: Original
Content
`,
			);

			renumberRoadmapReferences(new Map([["08", "07"]]));

			const content = getRoadmapContent();
			expect(content).toContain("### Phase 07:");
			expect(content).not.toContain("### Phase 08:");
		});

		test("updates plan references", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 08: Feature
Plans:
- [ ] 08-01: First task
- [ ] 08-02: Second task
`,
			);

			renumberRoadmapReferences(new Map([["08", "07"]]));

			const content = getRoadmapContent();
			expect(content).toContain("07-01:");
			expect(content).toContain("07-02:");
			expect(content).not.toContain("08-01:");
		});

		test("updates depends on references", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 09: Depends
**Depends on**: Phase 08
`,
			);

			renumberRoadmapReferences(new Map([["08", "07"]]));

			const content = getRoadmapContent();
			expect(content).toContain("**Depends on**: Phase 07");
		});

		test("renumbers single phase correctly", () => {
			// Single renumber is the primary use case
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 08: Feature
- [ ] 08-01: Task
**Depends on**: Phase 07
`,
			);

			renumberRoadmapReferences(new Map([["08", "07"]]));

			const content = getRoadmapContent();
			expect(content).toContain("### Phase 07: Feature");
			expect(content).toContain("07-01:");
			expect(content).not.toContain("### Phase 08:");
		});

		test("handles non-overlapping renumberings", () => {
			// When renumbering non-adjacent phases (no collision risk)
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

### Phase 05: Five
- [ ] 05-01: Task

### Phase 10: Ten
- [ ] 10-01: Task
`,
			);

			// Renumber disjoint phases
			renumberRoadmapReferences(
				new Map([
					["05", "04"],
					["10", "09"],
				]),
			);

			const content = getRoadmapContent();
			expect(content).toContain("### Phase 04:");
			expect(content).toContain("### Phase 09:");
			expect(content).not.toContain("### Phase 05:");
			expect(content).not.toContain("### Phase 10:");
		});

		test("updates checkbox plan items", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

Plans:
- [ ] 08-01: Pending task
- [x] 08-02: Completed task
`,
			);

			renumberRoadmapReferences(new Map([["08", "07"]]));

			const content = getRoadmapContent();
			expect(content).toContain("- [ ] 07-01:");
			expect(content).toContain("- [x] 07-02:");
		});
	});

	describe("updatePhaseChecklist", () => {
		test("does nothing when ROADMAP.md does not exist", () => {
			// Should not throw
			updatePhaseChecklist(new Map([["08", "07"]]));
		});

		test("updates phase checklist at top of file", () => {
			writeFileSync(
				ROADMAP_PATH,
				`# Roadmap

## Phases
- [ ] **Phase 8: XState Migration**
- [ ] **Phase 9: Final Cleanup**

### Phase 8: XState Migration
Content
`,
			);

			updatePhaseChecklist(new Map([["8", "7"]]));

			const content = getRoadmapContent();
			expect(content).toContain("**Phase 7:");
			expect(content).not.toContain("**Phase 8:");
		});
	});

	describe("getRoadmapContent and writeRoadmapContent", () => {
		test("returns empty string when file does not exist", () => {
			expect(getRoadmapContent()).toBe("");
		});

		test("reads existing content", () => {
			writeFileSync(ROADMAP_PATH, "# Test Content");
			expect(getRoadmapContent()).toBe("# Test Content");
		});

		test("writes content to file", () => {
			writeRoadmapContent("# New Content");
			expect(readFileSync(ROADMAP_PATH, "utf-8")).toBe("# New Content");
		});
	});
});
