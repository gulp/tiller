/**
 * Milestone state module for version-based release management
 *
 * Milestones group phases together for release workflow:
 * - Create: Register a version with associated phases
 * - Complete: Archive roadmap snapshot and optionally create git tag
 * - List: View current and past milestones
 *
 * File structure:
 * - Active milestones: .tiller/milestones.json
 * - Archived: .planning/milestones/v{version}-ROADMAP.md
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { logEvent } from "./events.js";
import { CORE_PATHS, findProjectRoot } from "./paths.js";
import { getPhaseInfo, type PhaseInfo } from "./phase.js";
import { getRoadmapContent } from "./roadmap-file.js";

// ============================================
// Milestone Types
// ============================================

/**
 * Milestone status (derived from phase states)
 */
export type MilestoneStatus =
	| "planning" // Not all phases started
	| "active" // Work in progress
	| "verifying" // All phases in verifying state
	| "ready" // All phases complete, ready for release
	| "archived"; // Released and archived

/**
 * Milestone metadata
 */
export interface MilestoneMetadata {
	version: string; // Semantic version (e.g., "1.0", "1.1", "2.0")
	title: string; // Human-readable title (e.g., "Tiller Core")
	phases: string[]; // Phase IDs in this milestone (e.g., ["01", "01.1", "02"])
	created: string; // ISO timestamp
	updated: string; // ISO timestamp
	archived_at?: string; // ISO timestamp when archived
	git_tag?: string; // Git tag name (e.g., "v1.0")
}

/**
 * Milestone with derived state
 */
export interface Milestone {
	metadata: MilestoneMetadata;
	status: MilestoneStatus; // Derived from phase states
	progress: {
		total_phases: number;
		complete_phases: number;
		active_phases: number;
		verifying_phases: number;
	};
	phase_info: PhaseInfo[]; // Detailed phase info
}

/**
 * Milestones storage format
 */
interface MilestonesFile {
	milestones: MilestoneMetadata[];
	current_version: string | null; // Currently active milestone version
}

// ============================================
// Path Resolution
// ============================================

// Derive from centralized CORE_PATHS
const MILESTONES_FILE = join(CORE_PATHS.TILLER_DIR, "milestones.json");
const ARCHIVE_DIR = ".planning/milestones";

/**
 * Ensure milestones directories exist
 */
function ensureMilestonesDirs(): void {
	const projectRoot = findProjectRoot();
	const tillerDir = CORE_PATHS.TILLER_DIR;
	const archiveDir = join(projectRoot, ARCHIVE_DIR);

	if (!existsSync(tillerDir)) {
		mkdirSync(tillerDir, { recursive: true });
	}
	if (!existsSync(archiveDir)) {
		mkdirSync(archiveDir, { recursive: true });
	}
}

/**
 * Get path to milestones.json
 */
export function getMilestonesPath(): string {
	return MILESTONES_FILE;
}

/**
 * Get path to archive directory
 */
export function getArchiveDir(): string {
	return join(findProjectRoot(), ARCHIVE_DIR);
}

/**
 * Get path to archived milestone roadmap
 */
export function getArchivePath(version: string): string {
	const normalizedVersion = version.startsWith("v") ? version : `v${version}`;
	return join(getArchiveDir(), `${normalizedVersion}-ROADMAP.md`);
}

// ============================================
// Milestone State Derivation
// ============================================

/**
 * Derive milestone status from phase states
 *
 * Priority logic:
 * - If all phases complete: "ready" (ready for release)
 * - If all phases in verifying: "verifying"
 * - If any phase active: "active"
 * - Otherwise: "planning"
 */
export function deriveMilestoneStatus(
	phaseInfos: PhaseInfo[],
): MilestoneStatus {
	if (phaseInfos.length === 0) {
		return "planning";
	}

	const complete = phaseInfos.filter((p) => p.state === "complete").length;
	const verifying = phaseInfos.filter((p) => p.state === "verifying").length;
	const active = phaseInfos.filter((p) => p.state === "active").length;

	// All complete?
	if (complete === phaseInfos.length) {
		return "ready";
	}

	// All in verifying (some may be complete)?
	if (verifying + complete === phaseInfos.length && verifying > 0) {
		return "verifying";
	}

	// Any active?
	if (active > 0) {
		return "active";
	}

	return "planning";
}

/**
 * Get progress counts from phase infos
 */
function getProgressCounts(phaseInfos: PhaseInfo[]): Milestone["progress"] {
	return {
		total_phases: phaseInfos.length,
		complete_phases: phaseInfos.filter((p) => p.state === "complete").length,
		active_phases: phaseInfos.filter((p) => p.state === "active").length,
		verifying_phases: phaseInfos.filter((p) => p.state === "verifying").length,
	};
}

// ============================================
// Milestone Storage
// ============================================

/**
 * Load milestones from storage
 */
function loadMilestonesFile(): MilestonesFile {
	const path = getMilestonesPath();

	if (!existsSync(path)) {
		return { milestones: [], current_version: null };
	}

	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as MilestonesFile;
	} catch {
		return { milestones: [], current_version: null };
	}
}

/**
 * Save milestones to storage
 */
function saveMilestonesFile(data: MilestonesFile): void {
	ensureMilestonesDirs();
	const path = getMilestonesPath();
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ============================================
// Milestone CRUD Operations
// ============================================

/**
 * Create a new milestone
 */
export function createMilestone(
	version: string,
	title: string,
	phases: string[],
): Milestone {
	ensureMilestonesDirs();

	const now = new Date().toISOString();
	const metadata: MilestoneMetadata = {
		version,
		title,
		phases,
		created: now,
		updated: now,
	};

	// Load existing milestones
	const data = loadMilestonesFile();

	// Check for duplicate version
	const existing = data.milestones.find((m) => m.version === version);
	if (existing) {
		throw new Error(`Milestone version ${version} already exists`);
	}

	// Add new milestone
	data.milestones.push(metadata);

	// Set as current if no current version
	if (!data.current_version) {
		data.current_version = version;
	}

	saveMilestonesFile(data);

	// Log event
	logEvent({
		event: "milestone_created",
		version,
		title,
		phases: phases.join(", "),
	});

	// Return full milestone with derived state
	return getMilestone(version)!;
}

/**
 * Get a milestone by version
 */
export function getMilestone(version: string): Milestone | null {
	const data = loadMilestonesFile();
	const metadata = data.milestones.find((m) => m.version === version);

	if (!metadata) {
		return null;
	}

	// Get phase info for each phase
	const phaseInfos: PhaseInfo[] = [];
	for (const phaseId of metadata.phases) {
		const info = getPhaseInfo(phaseId);
		if (info) {
			phaseInfos.push(info);
		}
	}

	// Derive status (archived if has archived_at)
	const status = metadata.archived_at
		? "archived"
		: deriveMilestoneStatus(phaseInfos);

	return {
		metadata,
		status,
		progress: getProgressCounts(phaseInfos),
		phase_info: phaseInfos,
	};
}

/**
 * List all milestones
 */
export function listMilestones(): Milestone[] {
	const data = loadMilestonesFile();

	return data.milestones
		.map((m) => getMilestone(m.version))
		.filter((m): m is Milestone => m !== null);
}

/**
 * List archived milestones from archive directory
 */
export function listArchivedMilestones(): Array<{
	version: string;
	path: string;
}> {
	const archiveDir = getArchiveDir();

	if (!existsSync(archiveDir)) {
		return [];
	}

	const files = readdirSync(archiveDir).filter(
		(f) => f.endsWith("-ROADMAP.md") && f.startsWith("v"),
	);

	return files.map((f) => {
		const version = f.replace("-ROADMAP.md", "");
		return {
			version,
			path: join(archiveDir, f),
		};
	});
}

/**
 * Get the current (active) milestone
 */
export function getCurrentMilestone(): Milestone | null {
	const data = loadMilestonesFile();

	if (!data.current_version) {
		return null;
	}

	return getMilestone(data.current_version);
}

/**
 * Set the current milestone
 */
export function setCurrentMilestone(version: string | null): void {
	const data = loadMilestonesFile();

	if (version !== null) {
		const exists = data.milestones.find((m) => m.version === version);
		if (!exists) {
			throw new Error(`Milestone version ${version} not found`);
		}
	}

	data.current_version = version;
	saveMilestonesFile(data);

	logEvent({
		event: "milestone_current_changed",
		version: version ?? "(none)",
	});
}

/**
 * Update milestone metadata
 */
export function updateMilestone(
	version: string,
	updates: Partial<Pick<MilestoneMetadata, "title" | "phases">>,
): Milestone | null {
	const data = loadMilestonesFile();
	const index = data.milestones.findIndex((m) => m.version === version);

	if (index === -1) {
		return null;
	}

	const metadata = data.milestones[index];

	if (updates.title !== undefined) {
		metadata.title = updates.title;
	}
	if (updates.phases !== undefined) {
		metadata.phases = updates.phases;
	}

	metadata.updated = new Date().toISOString();
	data.milestones[index] = metadata;
	saveMilestonesFile(data);

	logEvent({
		event: "milestone_updated",
		version,
		updates: Object.keys(updates).join(", "),
	});

	return getMilestone(version);
}

/**
 * Delete a milestone
 */
export function deleteMilestone(version: string): boolean {
	const data = loadMilestonesFile();
	const index = data.milestones.findIndex((m) => m.version === version);

	if (index === -1) {
		return false;
	}

	data.milestones.splice(index, 1);

	// Clear current if deleted
	if (data.current_version === version) {
		data.current_version = null;
	}

	saveMilestonesFile(data);

	logEvent({
		event: "milestone_deleted",
		version,
	});

	return true;
}

// ============================================
// Milestone Completion & Archival
// ============================================

/**
 * Check if a milestone can be completed
 * Returns validation result with reason if not ready
 */
export function canCompleteMilestone(
	version: string,
): { ready: boolean; reason?: string; incomplete_phases?: string[] } {
	const milestone = getMilestone(version);

	if (!milestone) {
		return { ready: false, reason: "Milestone not found" };
	}

	if (milestone.status === "archived") {
		return { ready: false, reason: "Milestone already archived" };
	}

	// Check if all phases are complete
	const incompletePhases = milestone.phase_info
		.filter((p) => p.state !== "complete")
		.map((p) => `${p.id} (${p.state})`);

	if (incompletePhases.length > 0) {
		return {
			ready: false,
			reason: `${incompletePhases.length} phase(s) not complete`,
			incomplete_phases: incompletePhases,
		};
	}

	return { ready: true };
}

/**
 * Archive a milestone's roadmap to .planning/milestones/
 */
export function archiveMilestoneRoadmap(version: string): string {
	ensureMilestonesDirs();

	const archivePath = getArchivePath(version);
	const roadmapContent = getRoadmapContent();

	if (!roadmapContent) {
		throw new Error("No ROADMAP.md content found to archive");
	}

	// Add archive header
	const archivedContent = `<!-- Archived: ${new Date().toISOString()} -->
<!-- Milestone: ${version} -->

${roadmapContent}`;

	writeFileSync(archivePath, archivedContent, "utf-8");

	return archivePath;
}

/**
 * Complete and archive a milestone
 *
 * Options:
 * - createTag: Create a git tag (default: false)
 * - skipValidation: Skip phase completion check (default: false)
 */
export function completeMilestone(
	version: string,
	options: {
		createTag?: boolean;
		skipValidation?: boolean;
	} = {},
): {
	milestone: Milestone;
	archive_path: string;
	git_tag?: string;
} {
	// Validate if not skipped
	if (!options.skipValidation) {
		const validation = canCompleteMilestone(version);
		if (!validation.ready) {
			throw new Error(`Cannot complete milestone: ${validation.reason}`);
		}
	}

	// Archive the roadmap
	const archivePath = archiveMilestoneRoadmap(version);

	// Update milestone metadata
	const data = loadMilestonesFile();
	const index = data.milestones.findIndex((m) => m.version === version);

	if (index === -1) {
		throw new Error(`Milestone ${version} not found`);
	}

	const now = new Date().toISOString();
	data.milestones[index].archived_at = now;
	data.milestones[index].updated = now;

	// Set git tag if requested
	const gitTag = options.createTag
		? version.startsWith("v")
			? version
			: `v${version}`
		: undefined;
	if (gitTag) {
		data.milestones[index].git_tag = gitTag;
	}

	saveMilestonesFile(data);

	// Log event
	logEvent({
		event: "milestone_completed",
		version,
		archive_path: archivePath,
		git_tag: gitTag,
	});

	const milestone = getMilestone(version)!;

	return {
		milestone,
		archive_path: archivePath,
		git_tag: gitTag,
	};
}

// ============================================
// Milestone Discovery from ROADMAP.md
// ============================================

/**
 * Parse milestone sections from ROADMAP.md content
 *
 * Looks for patterns like:
 * - "### Tiller Milestone (Current)"
 * - "### ACE Milestone (Parked)"
 */
export function parseMilestonesFromRoadmap(): Array<{
	title: string;
	isCurrent: boolean;
	phases: string[];
}> {
	const content = getRoadmapContent();
	if (!content) {
		return [];
	}

	const milestones: Array<{
		title: string;
		isCurrent: boolean;
		phases: string[];
	}> = [];

	// Match milestone headers: "### Title Milestone (Status)"
	const headerRegex = /### (.+?) Milestone(?:\s*\(([^)]+)\))?/g;
	let match;

	while ((match = headerRegex.exec(content)) !== null) {
		const title = match[1].trim();
		const status = match[2]?.toLowerCase() ?? "";
		const isCurrent = status === "current" || status === "";

		// Find phases listed under this milestone (looking for phase checkboxes)
		const startIndex = match.index + match[0].length;
		const nextMilestoneMatch = content
			.slice(startIndex)
			.match(/\n### .+ Milestone/);
		const endIndex = nextMilestoneMatch
			? startIndex + nextMilestoneMatch.index!
			: content.length;

		const section = content.slice(startIndex, endIndex);

		// Extract phase IDs from checkbox items like "- [ ] **Phase 1: Foundation**"
		const phaseRegex = /- \[[x ]\] \*\*Phase (\d+(?:\.\d+)?):?/gi;
		const phases: string[] = [];
		let phaseMatch;

		while ((phaseMatch = phaseRegex.exec(section)) !== null) {
			phases.push(phaseMatch[1]);
		}

		milestones.push({ title, isCurrent, phases });
	}

	return milestones;
}

/**
 * Suggest milestone from current ROADMAP.md structure
 * Useful for initial setup
 */
export function suggestMilestoneFromRoadmap(): {
	version: string;
	title: string;
	phases: string[];
} | null {
	const parsed = parseMilestonesFromRoadmap();
	const current = parsed.find((m) => m.isCurrent);

	if (!current) {
		return null;
	}

	// Derive version from title (e.g., "Tiller" -> "1.0", "Tiller v2" -> "2.0")
	const versionMatch = current.title.match(/v?(\d+(?:\.\d+)?)/i);
	const version = versionMatch ? versionMatch[1] : "1.0";

	return {
		version,
		title: current.title,
		phases: current.phases,
	};
}

// ============================================
// Milestone Statistics
// ============================================

/**
 * Get statistics for a milestone
 */
export function getMilestoneStats(
	version: string,
): {
	total_plans: number;
	completed_plans: number;
	active_plans: number;
	total_tracks: number;
	duration_days?: number;
} | null {
	const milestone = getMilestone(version);
	if (!milestone) {
		return null;
	}

	let totalPlans = 0;
	let completedPlans = 0;
	let activePlans = 0;
	let totalTracks = 0;

	for (const phase of milestone.phase_info) {
		totalTracks += phase.tracks.length;
		totalPlans += phase.progress.total;
		completedPlans += phase.progress.complete;
		activePlans += phase.progress.active;
	}

	// Calculate duration if archived
	let durationDays: number | undefined;
	if (milestone.metadata.archived_at) {
		const created = new Date(milestone.metadata.created).getTime();
		const archived = new Date(milestone.metadata.archived_at).getTime();
		durationDays = Math.ceil((archived - created) / (1000 * 60 * 60 * 24));
	}

	return {
		total_plans: totalPlans,
		completed_plans: completedPlans,
		active_plans: activePlans,
		total_tracks: totalTracks,
		duration_days: durationDays,
	};
}

// ============================================
// Context Injection
// ============================================

/**
 * Format a milestone for injection into prompts
 */
export function formatMilestoneForInjection(milestone: Milestone): string {
	const { metadata, status, progress } = milestone;

	const phaseList = milestone.phase_info
		.map((p) => `- Phase ${p.id}: ${p.name} [${p.state}]`)
		.join("\n");

	return `## Milestone: ${metadata.title} (${metadata.version})

**Status:** ${status}
**Progress:** ${progress.complete_phases}/${progress.total_phases} phases complete

### Phases
${phaseList}

### Next Steps
${
	status === "planning"
		? "Continue planning and executing phases"
		: status === "active"
			? "Complete active phases"
			: status === "verifying"
				? "Complete verification on all phases"
				: status === "ready"
					? "Ready to complete: `tiller milestone complete ${metadata.version}`"
					: "Milestone archived"
}
`;
}
