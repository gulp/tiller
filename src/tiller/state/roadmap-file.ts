/**
 * ROADMAP.md file parsing and manipulation
 *
 * Handles inserting/removing phase sections and updating references.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROADMAP_PATH = ".planning/ROADMAP.md";

export interface PhaseSection {
	id: string; // e.g., "03.1"
	name: string; // e.g., "State Machine Refactor"
	inserted: boolean; // Whether it has (INSERTED) marker
	startIndex: number; // Position in file
	endIndex: number; // End position in file
	content: string; // Full section content
}

/**
 * Parse all phase sections from ROADMAP.md
 */
export function parseRoadmapSections(): PhaseSection[] {
	if (!existsSync(ROADMAP_PATH)) {
		return [];
	}

	const content = readFileSync(ROADMAP_PATH, "utf-8");
	const sections: PhaseSection[] = [];

	// Match phase headers like "### Phase 3.1: State Machine Refactor (INSERTED)"
	const headerRegex = /### Phase (\d+(?:\.\d+)?): ([^\n(]+)(\(INSERTED\))?/g;
	let match;

	while ((match = headerRegex.exec(content)) !== null) {
		const id = match[1];
		const name = match[2].trim();
		const inserted = !!match[3];
		const startIndex = match.index;

		// Find end of section (next ### or end of file)
		const afterHeader = content.slice(startIndex + match[0].length);
		const nextSectionMatch = afterHeader.match(/\n### /);
		const endIndex = nextSectionMatch
			? startIndex + match[0].length + nextSectionMatch.index!
			: content.length;

		sections.push({
			id,
			name,
			inserted,
			startIndex,
			endIndex,
			content: content.slice(startIndex, endIndex),
		});
	}

	return sections;
}

/**
 * Generate a new phase section for ROADMAP.md
 */
export function generatePhaseSection(
	phaseId: string,
	name: string,
	dependsOn: string,
	options: {
		inserted?: boolean;
		goal?: string;
	} = {},
): string {
	const insertedMarker = options.inserted ? " (INSERTED)" : "";
	const goal = options.goal || `[Goal for ${name}]`;

	return `### Phase ${phaseId}: ${name}${insertedMarker}
**Goal**: ${goal}
**Depends on**: Phase ${dependsOn}
**Research**: Likely
**Plans**: TBD

Plans:
- [ ] ${phaseId}-01: [First plan]

`;
}

/**
 * Insert a new phase section after an existing phase
 * @param afterPhase - The phase ID after which to insert
 * @param newSection - The new section content to insert
 */
export function insertPhaseSection(
	afterPhase: string,
	newSection: string,
): void {
	if (!existsSync(ROADMAP_PATH)) {
		throw new Error(`${ROADMAP_PATH} not found`);
	}

	let content = readFileSync(ROADMAP_PATH, "utf-8");
	const sections = parseRoadmapSections();

	// Find the target phase section
	const targetSection = sections.find((s) => s.id === afterPhase);
	if (!targetSection) {
		throw new Error(`Phase ${afterPhase} not found in ROADMAP.md`);
	}

	// Insert after the target section
	content =
		content.slice(0, targetSection.endIndex) +
		"\n" +
		newSection +
		content.slice(targetSection.endIndex);

	writeFileSync(ROADMAP_PATH, content);
}

/**
 * Remove a phase section from ROADMAP.md
 */
export function removePhaseSection(phaseId: string): void {
	if (!existsSync(ROADMAP_PATH)) {
		throw new Error(`${ROADMAP_PATH} not found`);
	}

	let content = readFileSync(ROADMAP_PATH, "utf-8");
	const sections = parseRoadmapSections();

	const targetSection = sections.find((s) => s.id === phaseId);
	if (!targetSection) {
		throw new Error(`Phase ${phaseId} not found in ROADMAP.md`);
	}

	// Remove the section
	content =
		content.slice(0, targetSection.startIndex) +
		content.slice(targetSection.endIndex);

	// Clean up extra newlines
	content = content.replace(/\n{3,}/g, "\n\n");

	writeFileSync(ROADMAP_PATH, content);
}

/**
 * Update phase references throughout ROADMAP.md
 * Used during renumbering (e.g., 08 -> 07)
 * @param renumberMap - Map of old phase IDs to new phase IDs
 */
export function renumberRoadmapReferences(
	renumberMap: Map<string, string>,
): void {
	if (!existsSync(ROADMAP_PATH)) {
		return;
	}

	let content = readFileSync(ROADMAP_PATH, "utf-8");

	// Process in reverse order (highest first) to avoid collision issues
	const entries = Array.from(renumberMap.entries()).sort((a, b) => {
		// Sort by numeric value, descending
		const aNum = parseInt(a[0], 10);
		const bNum = parseInt(b[0], 10);
		return bNum - aNum;
	});

	for (const [oldId, newId] of entries) {
		// Update phase header: "### Phase 08:" -> "### Phase 07:"
		content = content.replace(
			new RegExp(`### Phase ${oldId}:`, "g"),
			`### Phase ${newId}:`,
		);

		// Update plan references: "08-01:" -> "07-01:"
		content = content.replace(
			new RegExp(`${oldId}-(\\d+):`, "g"),
			`${newId}-$1:`,
		);

		// Update "Depends on" references: "Phase 08" -> "Phase 07"
		content = content.replace(
			new RegExp(`Phase ${oldId}([^.\\d])`, "g"),
			`Phase ${newId}$1`,
		);

		// Update checkbox plan items: "- [ ] 08-01" -> "- [ ] 07-01"
		content = content.replace(
			new RegExp(`- \\[[ x]\\] ${oldId}-`, "g"),
			(match) => match.replace(`${oldId}-`, `${newId}-`),
		);
	}

	writeFileSync(ROADMAP_PATH, content);
}

/**
 * Update the phase checklist in ROADMAP.md (the summary list at top)
 * Updates lines like "- [ ] **Phase 7: XState Migration**"
 */
export function updatePhaseChecklist(renumberMap: Map<string, string>): void {
	if (!existsSync(ROADMAP_PATH)) {
		return;
	}

	let content = readFileSync(ROADMAP_PATH, "utf-8");

	// Process in reverse order
	const entries = Array.from(renumberMap.entries()).sort((a, b) => {
		const aNum = parseInt(a[0], 10);
		const bNum = parseInt(b[0], 10);
		return bNum - aNum;
	});

	for (const [oldId, newId] of entries) {
		// Update checklist items: "**Phase 8:" -> "**Phase 7:"
		content = content.replace(
			new RegExp(`\\*\\*Phase ${oldId}:`, "g"),
			`**Phase ${newId}:`,
		);
	}

	writeFileSync(ROADMAP_PATH, content);
}

/**
 * Get the raw content of ROADMAP.md
 */
export function getRoadmapContent(): string {
	if (!existsSync(ROADMAP_PATH)) {
		return "";
	}
	return readFileSync(ROADMAP_PATH, "utf-8");
}

/**
 * Write content to ROADMAP.md
 */
export function writeRoadmapContent(content: string): void {
	writeFileSync(ROADMAP_PATH, content);
}
