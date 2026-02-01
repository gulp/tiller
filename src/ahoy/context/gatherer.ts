/**
 * Context gatherer for planning data
 * Collects all data needed for phase planning from project files
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import yaml from "js-yaml";

export interface PlanningContext {
	initiative: string;
	phase: number;
	project: {
		name: string;
		description: string;
		coreValue: string;
	};
	roadmap: {
		phases: Array<{
			number: string;
			name: string;
			status: string;
			plans: number;
		}>;
		currentPhase: {
			number: string;
			name: string;
			description: string;
			plans: string[];
		};
	};
	state: {
		proposed: Record<string, string>;
		authoritative: Record<string, string>;
	};
	priorSummaries: Array<{
		phase: string;
		plan: string;
		keyDecisions: string[];
		keyFiles: string[];
		techAdded: string[];
	}>;
	sourceFiles: Array<{ path: string; purpose: string }>;
}

interface SummaryFrontmatter {
	phase?: string;
	plan?: string | number;
	status?: string;
	"key-decisions"?: string[];
	"key-files"?: { created?: string[]; modified?: string[] } | string[];
	"tech-stack"?: { added?: string[]; patterns?: string[] } | string[];
}

/**
 * Parse YAML frontmatter from markdown file content
 */
function parseFrontmatter(content: string): Record<string, unknown> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	try {
		return (yaml.load(match[1]) as Record<string, unknown>) || {};
	} catch {
		return {};
	}
}

/**
 * Read file content, returning empty string if file doesn't exist
 */
async function safeReadFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Extract project info from PROJECT.md
 */
function parseProject(content: string): PlanningContext["project"] {
	let name = "";
	let description = "";
	let coreValue = "";

	// Find title (first # heading)
	const titleMatch = content.match(/^# (.+)$/m);
	if (titleMatch) {
		name = titleMatch[1].trim();
	}

	// Find "What This Is" section for description
	const whatThisIsMatch = content.match(
		/## What This Is\s*\n\n([\s\S]*?)(?=\n##|$)/,
	);
	if (whatThisIsMatch) {
		description = whatThisIsMatch[1].trim().split("\n")[0];
	}

	// Find "Core Value" section
	const coreValueMatch = content.match(
		/## Core Value\s*\n\n([\s\S]*?)(?=\n##|$)/,
	);
	if (coreValueMatch) {
		coreValue = coreValueMatch[1].trim().split("\n")[0];
	}

	return { name, description, coreValue };
}

/**
 * Extract phases and current phase from ROADMAP.md
 */
function parseRoadmap(
	content: string,
	targetPhase: number,
): PlanningContext["roadmap"] {
	const phases: PlanningContext["roadmap"]["phases"] = [];
	const currentPhase: PlanningContext["roadmap"]["currentPhase"] = {
		number: "",
		name: "",
		description: "",
		plans: [],
	};

	// Parse phase table from Progress section
	const tableMatch = content.match(
		/\| Phase \| Plans.*?\n\|[-|]+\n([\s\S]*?)(?=\n\n|$)/,
	);
	if (tableMatch) {
		const rows = tableMatch[1].trim().split("\n");
		for (const row of rows) {
			const cols = row
				.split("|")
				.map((c) => c.trim())
				.filter(Boolean);
			if (cols.length >= 3) {
				const phaseMatch = cols[0].match(/(\d+(?:\.\d+)?)\.\s*(.+)/);
				if (phaseMatch) {
					const phaseNum = phaseMatch[1];
					const phaseName = phaseMatch[2].replace(/\*\*/g, "");
					const plansMatch = cols[1].match(/(\d+)\/(\d+)/);
					const status = cols[2];
					phases.push({
						number: phaseNum,
						name: phaseName,
						status: status,
						plans: plansMatch ? parseInt(plansMatch[2], 10) : 0,
					});
				}
			}
		}
	}

	// Find phase details section for target phase
	const phasePattern = new RegExp(
		`### Phase ${targetPhase}[:.\\s]+([^\\n]+)\\n([\\s\\S]*?)(?=\\n### Phase \\d|\\n---\\n|$)`,
		"i",
	);
	const phaseMatch = content.match(phasePattern);
	if (phaseMatch) {
		currentPhase.number = String(targetPhase);
		currentPhase.name = phaseMatch[1].replace(/\*\*/g, "").trim();

		// Extract goal/description
		const goalMatch = phaseMatch[2].match(/\*\*Goal\*\*:\s*(.+)/);
		if (goalMatch) {
			currentPhase.description = goalMatch[1].trim();
		}

		// Extract plans list
		const plansSection = phaseMatch[2].match(/Plans:\n([\s\S]*?)(?=\n\n|$)/);
		if (plansSection) {
			const planLines = plansSection[1].split("\n");
			for (const line of planLines) {
				const planMatch = line.match(/- \[[ x]\] (\d+-\d+):/);
				if (planMatch) {
					currentPhase.plans.push(planMatch[1]);
				}
			}
		}
	}

	return { phases, currentPhase };
}

/**
 * Extract proposed and authoritative state from STATE.md
 */
function parseState(content: string): PlanningContext["state"] {
	const proposed: Record<string, string> = {};
	const authoritative: Record<string, string> = {};

	// Simple key-value extraction from sections
	const proposedMatch = content.match(/## Proposed\s*\n([\s\S]*?)(?=\n## |$)/);
	if (proposedMatch) {
		const lines = proposedMatch[1].split("\n");
		for (const line of lines) {
			const kvMatch = line.match(/^\*\*(.+?)\*\*:\s*(.+)/);
			if (kvMatch) {
				proposed[kvMatch[1]] = kvMatch[2];
			}
		}
	}

	const authMatch = content.match(
		/## (?:Authoritative|Current Position)\s*\n([\s\S]*?)(?=\n## |$)/,
	);
	if (authMatch) {
		const lines = authMatch[1].split("\n");
		for (const line of lines) {
			const kvMatch = line.match(/^(?:\*\*)?(.+?)(?:\*\*)?:\s*(.+)/);
			if (
				kvMatch &&
				!line.startsWith("#") &&
				!line.startsWith("|") &&
				kvMatch[1].trim()
			) {
				authoritative[kvMatch[1].replace(/\*\*/g, "")] = kvMatch[2];
			}
		}
	}

	return { proposed, authoritative };
}

/**
 * Gather planning context for a phase
 */
export async function gatherPlanningContext(
	initiative: string,
	phase: number,
	cwd: string = process.cwd(),
): Promise<PlanningContext> {
	// v0.2.0 contract: specs/{initiative}/ required, no fallbacks
	const baseDir = join(cwd, "specs", initiative);
	const phasesDir = join(baseDir, "phases");

	if (!existsSync(baseDir)) {
		throw new Error(
			`Initiative "${initiative}" not found at specs/${initiative}/. ` +
				`Run "ahoy init ${initiative}" first.`,
		);
	}

	// Read core files
	const [projectContent, roadmapContent, stateContent] = await Promise.all([
		safeReadFile(join(baseDir, "PROJECT.md")),
		safeReadFile(join(baseDir, "ROADMAP.md")),
		safeReadFile(join(baseDir, "STATE.md")),
	]);

	// Parse core data
	const project = parseProject(projectContent);
	const roadmap = parseRoadmap(roadmapContent, phase);
	const state = parseState(stateContent);

	// Find and parse prior summaries for phases before target phase
	const priorSummaries: PlanningContext["priorSummaries"] = [];
	const summaryFiles = await glob(`${phasesDir}/**/*SUMMARY*.md`);

	for (const summaryPath of summaryFiles) {
		const content = await safeReadFile(summaryPath);
		const frontmatter = parseFrontmatter(content) as SummaryFrontmatter;

		// Extract phase number from path or frontmatter
		const pathMatch = summaryPath.match(
			/(\d+(?:\.\d+)?)-[^/]+\/\d+-(\d+)-SUMMARY/,
		);
		const phaseNum = frontmatter.phase || (pathMatch ? pathMatch[1] : "");
		const planNum =
			frontmatter.plan?.toString() || (pathMatch ? pathMatch[2] : "");

		// Only include phases before target
		const phaseNumeric = parseFloat(phaseNum);
		if (phaseNumeric < phase) {
			// Handle nested key-files structure: { created: [], modified: [] } or flat array
			const keyFilesRaw = frontmatter["key-files"];
			let keyFiles: string[] = [];
			if (Array.isArray(keyFilesRaw)) {
				keyFiles = keyFilesRaw;
			} else if (keyFilesRaw && typeof keyFilesRaw === "object") {
				keyFiles = [
					...(keyFilesRaw.created || []),
					...(keyFilesRaw.modified || []),
				];
			}

			// Handle nested tech-stack structure: { added: [], patterns: [] } or flat array
			const techStackRaw = frontmatter["tech-stack"];
			let techAdded: string[] = [];
			if (Array.isArray(techStackRaw)) {
				techAdded = techStackRaw;
			} else if (techStackRaw && typeof techStackRaw === "object") {
				techAdded = techStackRaw.added || [];
			}

			priorSummaries.push({
				phase: phaseNum,
				plan: planNum,
				keyDecisions: frontmatter["key-decisions"] || [],
				keyFiles,
				techAdded,
			});
		}
	}

	// Sort by phase/plan
	priorSummaries.sort((a, b) => {
		const phaseCompare = parseFloat(a.phase) - parseFloat(b.phase);
		if (phaseCompare !== 0) return phaseCompare;
		return parseInt(a.plan, 10) - parseInt(b.plan, 10);
	});

	// Collect source files from summaries
	const sourceFilesSet = new Set<string>();
	for (const summary of priorSummaries) {
		for (const file of summary.keyFiles) {
			sourceFilesSet.add(file);
		}
	}

	const sourceFiles: PlanningContext["sourceFiles"] = Array.from(
		sourceFilesSet,
	).map((path) => ({
		path,
		purpose: "From prior plan summaries",
	}));

	return {
		initiative,
		phase,
		project,
		roadmap,
		state,
		priorSummaries,
		sourceFiles,
	};
}
