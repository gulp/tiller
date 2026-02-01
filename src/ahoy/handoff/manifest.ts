/**
 * Handoff manifest types and utilities for ahoy artifact management
 *
 * Manifests are created when plans are approved and handed off from WIP to specs.
 * Tiller reads these manifests to import approved plans.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Individual plan artifact in a handoff
 */
export interface PlanArtifact {
	source: string; // WIP path (original location)
	destination: string; // specs/ path (where it was copied)
	planId: string; // e.g., "06.2-01"
}

/**
 * Handoff manifest - created when plans are approved
 * Stored at .ahoy/handoffs/{initiative}-{phase}.json
 */
export interface HandoffManifest {
	initiative: string;
	phase: string;
	handoffId: string; // Unique ID for this handoff (e.g., "ho-lxyz123")
	timestamp: string; // ISO timestamp
	artifacts: {
		plans: PlanArtifact[];
		context?: string; // Copied CONTEXT.md path
		research?: string; // Copied RESEARCH.md path
		discovery?: string; // Copied DISCOVERY.md path
	};
	state: "approved"; // Always approved when manifest created
	metadata?: Record<string, string>; // Optional extra context
}

/**
 * Base directory for handoff manifests
 */
export function getHandoffsBase(cwd: string = process.cwd()): string {
	return join(cwd, ".ahoy", "handoffs");
}

/**
 * Path to a specific handoff manifest file
 */
export function getHandoffManifestPath(
	initiative: string,
	phase: string,
	cwd?: string,
): string {
	return join(getHandoffsBase(cwd), `${initiative}-${phase}.json`);
}

/**
 * Read a handoff manifest (null if doesn't exist)
 */
export async function readHandoffManifest(
	initiative: string,
	phase: string,
	cwd?: string,
): Promise<HandoffManifest | null> {
	const manifestPath = getHandoffManifestPath(initiative, phase, cwd);

	if (!existsSync(manifestPath)) {
		return null;
	}

	const content = await readFile(manifestPath, "utf-8");
	return JSON.parse(content) as HandoffManifest;
}

/**
 * Write a handoff manifest to disk
 */
export async function writeHandoffManifest(
	manifest: HandoffManifest,
	cwd?: string,
): Promise<void> {
	const handoffsDir = getHandoffsBase(cwd);
	await mkdir(handoffsDir, { recursive: true });

	const manifestPath = getHandoffManifestPath(
		manifest.initiative,
		manifest.phase,
		cwd,
	);
	await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * List all handoff manifests for an initiative
 */
export async function listHandoffs(
	initiative: string,
	cwd?: string,
): Promise<HandoffManifest[]> {
	const handoffsDir = getHandoffsBase(cwd);

	if (!existsSync(handoffsDir)) {
		return [];
	}

	const files = await readdir(handoffsDir);
	const prefix = `${initiative}-`;

	const manifestFiles = files.filter(
		(f) => f.startsWith(prefix) && f.endsWith(".json"),
	);

	const manifests: HandoffManifest[] = [];
	for (const file of manifestFiles) {
		const content = await readFile(join(handoffsDir, file), "utf-8");
		manifests.push(JSON.parse(content) as HandoffManifest);
	}

	return manifests;
}

/**
 * List all handoff manifests in the project
 */
export async function listAllHandoffs(
	cwd?: string,
): Promise<HandoffManifest[]> {
	const handoffsDir = getHandoffsBase(cwd);

	if (!existsSync(handoffsDir)) {
		return [];
	}

	const files = await readdir(handoffsDir);
	const manifestFiles = files.filter((f) => f.endsWith(".json"));

	const manifests: HandoffManifest[] = [];
	for (const file of manifestFiles) {
		const content = await readFile(join(handoffsDir, file), "utf-8");
		manifests.push(JSON.parse(content) as HandoffManifest);
	}

	return manifests;
}

/**
 * Generate a unique handoff ID
 * Format: "ho-{timestamp-base36}" for short, unique IDs
 */
export function generateHandoffId(): string {
	return `ho-${Date.now().toString(36)}`;
}

/**
 * Derive destination path in specs/ from WIP artifact
 *
 * WIP: .ahoy/wip/{initiative}/{phase}/{filename}
 * Specs: specs/{initiative}/phases/{phasePrefix}-{phaseName}/{filename}
 *
 * @param initiative - Initiative name
 * @param phaseName - Phase name (without prefix)
 * @param phasePrefix - Phase prefix from roadmap (e.g., "06" for phase 6)
 * @param filename - Artifact filename (e.g., "01-PLAN.md", "CONTEXT.md")
 * @param cwd - Working directory
 */
export function deriveSpecsPath(
	initiative: string,
	phaseName: string,
	phasePrefix: string,
	filename: string,
	cwd: string = process.cwd(),
): string {
	return join(
		cwd,
		"specs",
		initiative,
		"phases",
		`${phasePrefix}-${phaseName}`,
		filename,
	);
}

/**
 * Create a handoff manifest
 */
export function createHandoffManifest(
	initiative: string,
	phase: string,
	plans: PlanArtifact[],
	options?: {
		context?: string;
		research?: string;
		discovery?: string;
		metadata?: Record<string, string>;
	},
): HandoffManifest {
	return {
		initiative,
		phase,
		handoffId: generateHandoffId(),
		timestamp: new Date().toISOString(),
		artifacts: {
			plans,
			context: options?.context,
			research: options?.research,
			discovery: options?.discovery,
		},
		state: "approved",
		metadata: options?.metadata,
	};
}
