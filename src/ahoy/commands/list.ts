/**
 * List command - List initiatives
 *
 * Lists initiatives from plans/ directory with metadata.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

interface Initiative {
	name: string;
	path: string;
	phaseCount: number;
	planCount: number;
	error?: string;
}

/**
 * Safe directory read with error handling (string mode)
 */
function safeReadDirStrings(dirPath: string): string[] {
	try {
		return readdirSync(dirPath);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		console.error(`Warning: Could not read ${dirPath}: ${err.message}`);
		return [];
	}
}

/**
 * Safe directory read with error handling (Dirent mode)
 */
function safeReadDirDirents(dirPath: string): Dirent[] {
	try {
		return readdirSync(dirPath, { withFileTypes: true });
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		console.error(`Warning: Could not read ${dirPath}: ${err.message}`);
		return [];
	}
}

/**
 * Count plans in a phase directory
 */
function countPlans(phasePath: string): number {
	if (!existsSync(phasePath)) return 0;
	const files = safeReadDirStrings(phasePath);
	return files.filter((f) => f.endsWith("-PLAN.md")).length;
}

/**
 * Scan plans/ for initiatives
 */
function scanInitiatives(cwd: string = process.cwd()): Initiative[] {
	const plansDir = join(cwd, "plans");
	if (!existsSync(plansDir)) {
		return [];
	}

	const entries = safeReadDirDirents(plansDir);
	const initiatives: Initiative[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		// Skip hidden directories
		if (entry.name.startsWith(".")) continue;

		const initPath = join(plansDir, entry.name);

		let phases: Dirent[];
		try {
			phases = readdirSync(initPath, { withFileTypes: true }).filter(
				(e) => e.isDirectory() && !e.name.startsWith("."),
			);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			// Record error but continue scanning other initiatives
			initiatives.push({
				name: entry.name,
				path: initPath,
				phaseCount: 0,
				planCount: 0,
				error: `Could not read: ${err.message}`,
			});
			continue;
		}

		let totalPlans = 0;
		for (const phase of phases) {
			totalPlans += countPlans(join(initPath, phase.name));
		}

		initiatives.push({
			name: entry.name,
			path: initPath,
			phaseCount: phases.length,
			planCount: totalPlans,
		});
	}

	return initiatives;
}

export function registerListCommand(program: Command): void {
	program
		.command("list")
		.description("List initiatives")
		.option("--json", "Output as JSON")
		.action((options: { json?: boolean }) => {
			const cwd = process.cwd();
			const initiatives = scanInitiatives(cwd);

			if (options.json) {
				console.log(JSON.stringify({ initiatives }, null, 2));
				return;
			}

			if (initiatives.length === 0) {
				console.log("No initiatives in plans/");
				return;
			}

			console.log("Initiatives:\n");
			for (const init of initiatives) {
				if (init.error) {
					console.log(`  ${init.name}/ (error: ${init.error})`);
				} else {
					console.log(
						`  ${init.name}/ (${init.phaseCount} phases, ${init.planCount} plans)`,
					);
				}
			}
		});
}
