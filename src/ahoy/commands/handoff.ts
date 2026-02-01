/**
 * Handoff command - Approve and transfer WIP plans to specs/
 *
 * Provides the approval gate between WIP planning artifacts and canonical specs/ location.
 * Plans only become visible to tiller after explicit handoff.
 */

import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Command } from "commander";
import type { PlanArtifact } from "../handoff/manifest.js";
import {
	createHandoffManifest,
	getHandoffManifestPath,
	writeHandoffManifest,
} from "../handoff/manifest.js";
import { readSession, transitionState } from "../hsm/session.js";
import { getWipArtifacts, getWipDir } from "../wip/paths.js";

interface HandoffOptions {
	dryRun?: boolean;
	force?: boolean;
}

/**
 * Find phase directory name from specs/{initiative}/phases/ by phase number
 * Returns the full directory name (e.g., "06.2-ahoy-hsm")
 */
function findPhaseDir(
	initiative: string,
	phase: string,
	cwd: string = process.cwd(),
): string | null {
	const phasesDir = join(cwd, "specs", initiative, "phases");
	if (!existsSync(phasesDir)) {
		return null;
	}

	const dirs = readdirSync(phasesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	// Find directory starting with the phase number
	// e.g., phase "6.2" matches "06.2-ahoy-hsm" or "6.2-something"
	const normalizedPhase = phase.replace(/^0+/, ""); // Remove leading zeros

	for (const dir of dirs) {
		const match = dir.match(/^(\d+(?:\.\d+)?)-/);
		if (match) {
			const dirPhase = match[1].replace(/^0+/, "");
			if (dirPhase === normalizedPhase) {
				return dir;
			}
		}
	}

	return null;
}

/**
 * Parse phase name from ROADMAP.md for a given phase number
 */
async function parsePhaseNameFromRoadmap(
	initiative: string,
	phase: string,
	cwd: string = process.cwd(),
): Promise<string | null> {
	const roadmapPath = join(cwd, "specs", initiative, "ROADMAP.md");
	if (!existsSync(roadmapPath)) {
		return null;
	}

	const content = await readFile(roadmapPath, "utf-8");
	const normalizedPhase = phase.replace(/^0+/, "");

	// Match patterns like "**Phase 6.2: Ahoy HSM**" or "**Phase 1: Foundation**"
	const phasePattern = new RegExp(
		`\\*\\*Phase\\s+${normalizedPhase.replace(".", "\\.")}:\\s*([^*]+)\\*\\*`,
		"i",
	);
	const match = content.match(phasePattern);

	if (match) {
		// Convert "Ahoy HSM" to "ahoy-hsm"
		return match[1]
			.trim()
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9-]/g, "");
	}

	return null;
}

/**
 * Get the specs destination directory for a phase
 */
async function getSpecsDestDir(
	initiative: string,
	phase: string,
	cwd: string = process.cwd(),
): Promise<string | null> {
	// First, check if phase directory already exists
	const existingDir = findPhaseDir(initiative, phase, cwd);
	if (existingDir) {
		return join(cwd, "specs", initiative, "phases", existingDir);
	}

	// Otherwise, try to parse phase name from ROADMAP.md
	const phaseName = await parsePhaseNameFromRoadmap(initiative, phase, cwd);
	if (!phaseName) {
		return null;
	}

	// Format phase number with leading zero if needed
	const phaseNum = phase.includes(".") ? phase : phase.padStart(2, "0");
	return join(cwd, "specs", initiative, "phases", `${phaseNum}-${phaseName}`);
}

/**
 * Get the destination filename with proper phase prefix
 */
function getDestFilename(sourceFilename: string, phasePrefix: string): string {
	// CONTEXT.md → {phase}-CONTEXT.md
	// RESEARCH.md → {phase}-RESEARCH.md
	// DISCOVERY.md → DISCOVERY.md (no prefix)
	// 01-PLAN.md → {phase}-01-PLAN.md

	if (sourceFilename === "DISCOVERY.md") {
		return sourceFilename;
	}

	if (sourceFilename === "CONTEXT.md" || sourceFilename === "RESEARCH.md") {
		return `${phasePrefix}-${sourceFilename}`;
	}

	// For plan files like "01-PLAN.md"
	if (sourceFilename.endsWith("-PLAN.md")) {
		return `${phasePrefix}-${sourceFilename}`;
	}

	return sourceFilename;
}

export function registerHandoffCommand(program: Command): void {
	program
		.command("handoff <initiative> <phase>")
		.description("Approve and transfer WIP plans to specs/")
		.option("--dry-run", "Show what would be copied without copying")
		.option("--force", "Handoff even if session not in review state")
		.action(
			async (initiative: string, phase: string, options: HandoffOptions) => {
				const cwd = process.cwd();

				// 1. Validate initiative exists
				const specsDir = join(cwd, "specs", initiative);
				if (!existsSync(specsDir)) {
					console.error(
						`Error: Initiative '${initiative}' not found in specs/`,
					);
					process.exit(1);
				}

				// 2. Check session state (unless --force)
				if (!options.force) {
					const session = await readSession(initiative, phase, cwd);
					if (!session) {
						console.error(
							`Error: No session found for ${initiative} phase ${phase}`,
						);
						console.log("\nStart a planning session with: ahoy phase prime");
						console.log("Or use --force to skip session validation");
						process.exit(1);
					}

					const currentState = `${session.workflow}/${session.state}`;
					if (currentState !== "planning/review") {
						console.error(
							`Error: Session is in '${currentState}', expected 'planning/review'`,
						);
						console.log("\nUse --force to handoff anyway");
						process.exit(1);
					}
				}

				// 3. Get WIP artifacts
				const wipDir = getWipDir(initiative, phase, cwd);
				if (!existsSync(wipDir)) {
					console.error(
						`Error: No WIP artifacts found for ${initiative} phase ${phase}`,
					);
					console.log(`Expected at: ${wipDir}`);
					process.exit(1);
				}

				const artifacts = await getWipArtifacts(initiative, phase, cwd);

				// 4. Validate at least one plan exists
				if (artifacts.plans.length === 0) {
					console.error(
						"Error: Nothing to handoff - no plan files found in WIP",
					);
					console.log(`WIP directory: ${wipDir}`);
					process.exit(1);
				}

				// 5. Derive specs/ destination
				const destDir = await getSpecsDestDir(initiative, phase, cwd);
				if (!destDir) {
					console.error(
						`Error: Cannot determine phase name for phase ${phase}`,
					);
					console.log(
						"Check ROADMAP.md or create the phase directory manually",
					);
					process.exit(1);
				}

				// Extract phase prefix for filename prefixing
				const phaseDirName = basename(destDir);
				const phasePrefix = phaseDirName.split("-")[0];

				// 6. Check if destination has existing files
				if (existsSync(destDir)) {
					const existingFiles = readdirSync(destDir);
					if (existingFiles.length > 0 && !options.force) {
						console.error(`Error: Destination already has files: ${destDir}`);
						console.log("\nUse --force to overwrite existing files");
						process.exit(1);
					}
				}

				// Build list of files to copy
				const filesToCopy: Array<{
					source: string;
					dest: string;
					filename: string;
				}> = [];

				if (artifacts.context) {
					filesToCopy.push({
						source: join(wipDir, "CONTEXT.md"),
						dest: join(destDir, getDestFilename("CONTEXT.md", phasePrefix)),
						filename: getDestFilename("CONTEXT.md", phasePrefix),
					});
				}

				if (artifacts.research) {
					filesToCopy.push({
						source: join(wipDir, "RESEARCH.md"),
						dest: join(destDir, getDestFilename("RESEARCH.md", phasePrefix)),
						filename: getDestFilename("RESEARCH.md", phasePrefix),
					});
				}

				if (artifacts.discovery) {
					filesToCopy.push({
						source: join(wipDir, "DISCOVERY.md"),
						dest: join(destDir, getDestFilename("DISCOVERY.md", phasePrefix)),
						filename: getDestFilename("DISCOVERY.md", phasePrefix),
					});
				}

				for (const planFile of artifacts.plans) {
					filesToCopy.push({
						source: join(wipDir, planFile),
						dest: join(destDir, getDestFilename(planFile, phasePrefix)),
						filename: getDestFilename(planFile, phasePrefix),
					});
				}

				// 7. Dry run output
				if (options.dryRun) {
					console.log(`Handoff (dry-run): ${initiative} phase ${phase}\n`);
					console.log(`Would copy to ${destDir}:`);
					for (const file of filesToCopy) {
						console.log(`  - ${file.filename}`);
					}
					console.log(
						`\nWould create manifest: ${getHandoffManifestPath(initiative, phase, cwd)}`,
					);
					console.log("Would transition state to: planning/approved");
					return;
				}

				// 8. Create destination directory
				await mkdir(destDir, { recursive: true });

				// 9. Copy files
				const planArtifacts: PlanArtifact[] = [];
				let contextPath: string | undefined;
				let researchPath: string | undefined;
				let discoveryPath: string | undefined;

				for (const file of filesToCopy) {
					await copyFile(file.source, file.dest);

					// Track artifacts for manifest
					if (
						file.filename.endsWith("-CONTEXT.md") ||
						file.filename === "CONTEXT.md"
					) {
						contextPath = file.dest;
					} else if (
						file.filename.endsWith("-RESEARCH.md") ||
						file.filename === "RESEARCH.md"
					) {
						researchPath = file.dest;
					} else if (file.filename === "DISCOVERY.md") {
						discoveryPath = file.dest;
					} else if (file.filename.endsWith("-PLAN.md")) {
						// Extract plan ID from filename like "06.2-01-PLAN.md"
						const planMatch = file.filename.match(/^(.+)-PLAN\.md$/);
						const planId = planMatch ? planMatch[1] : file.filename;
						planArtifacts.push({
							source: file.source,
							destination: file.dest,
							planId,
						});
					}
				}

				// 10. Create handoff manifest
				const manifest = createHandoffManifest(
					initiative,
					phase,
					planArtifacts,
					{
						context: contextPath,
						research: researchPath,
						discovery: discoveryPath,
					},
				);
				await writeHandoffManifest(manifest, cwd);

				// 11. Transition session state to approved
				try {
					await transitionState(
						initiative,
						phase,
						"planning/approved",
						"Handoff complete",
						cwd,
					);
				} catch {
					// Session may not exist if --force was used, that's OK
				}

				// 12. Print summary
				console.log(`Handoff: ${initiative} phase ${phase}\n`);
				console.log(`Copied to ${destDir}:`);
				for (const file of filesToCopy) {
					console.log(`  - ${file.filename}`);
				}
				console.log(
					`\nManifest: ${getHandoffManifestPath(initiative, phase, cwd)}`,
				);
				console.log("State: planning/approved");
				console.log(`\nReady for: tiller import ${initiative}`);
			},
		);
}
