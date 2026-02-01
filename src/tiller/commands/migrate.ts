/**
 * tiller migrate - Migrate projects to v0.2.0 contract structure
 *
 * Moves .planning/ to specs/{initiative}/ and updates track IDs
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import {
	listRuns,
	saveRun,
	exportRunsToJsonl,
	getRunsJsonlPath,
} from "../state/run.js";
import {
	migratePlanRefFilenames,
	rollbackMigration,
} from "../state/migration.js";
import { CORE_PATHS } from "../state/paths.js";
import type { Run } from "../types/index.js";

const { RUNS_DIR } = CORE_PATHS;

export function registerMigrateCommand(program: Command): void {
	program
		.command("migrate <initiative>")
		.description("Migrate existing project to v0.2.0 contract structure")
		.option("--dry-run", "Show what would be migrated without changes")
		.option(
			"--to-immutable-ids",
			"Migrate run IDs to immutable format (run-{random})",
		)
		.option(
			"--planning-dir <dir>",
			"Source planning directory (default: .planning)",
		)
		.action(
			(
				initiative: string,
				options: {
					dryRun?: boolean;
					toImmutableIds?: boolean;
					planningDir?: string;
				},
			) => {
				// Handle ID migration separately
				if (options.toImmutableIds) {
					console.log("Migrating run IDs to immutable format...\n");

					const result = migratePlanRefFilenames(options.dryRun ?? false);

					if (options.dryRun) {
						console.log("[DRY RUN] Would migrate:");
						for (const m of result.migrations) {
							console.log(`  ${m.oldId} → ${m.newId}`);
							console.log(`    ${m.oldPath} → ${m.newPath}`);
						}
						console.log(`\nTotal: ${result.migratedCount} runs`);
					} else {
						console.log(`Migrated ${result.migratedCount} runs:`);
						for (const m of result.migrations) {
							console.log(`  ${m.oldId} → ${m.newId}`);
						}

						// Export to JSONL
						console.log("\nExporting to runs.jsonl...");
						const { count } = exportRunsToJsonl(getRunsJsonlPath());
						console.log(`Exported ${count} runs`);
					}

					return;
				}

				console.log(`Migrating to initiative: ${initiative}`);

				const planningDir = options.planningDir ?? ".planning";
				const specsDir = `specs/${initiative}`;

				if (!existsSync(planningDir)) {
					console.error(`No ${planningDir}/ directory found`);
					process.exit(1);
				}

				if (options.dryRun) {
					console.log("\n[DRY RUN] Would perform:");
					console.log(`  1. Create ${specsDir}/`);
					console.log(`  2. Move ${planningDir}/* to ${specsDir}/`);
					console.log("  3. Update track IDs with initiative prefix");
					console.log("  4. Update track plan_path references");

					// Show what tracks would be updated
					const tracks = listRuns();
					const legacyTracks = tracks.filter((t) => !t.initiative);
					if (legacyTracks.length > 0) {
						console.log("\nTracks to update:");
						for (const track of legacyTracks) {
							const newPath = track.plan_path.replace(
								`${planningDir}/`,
								`specs/${initiative}/`,
							);
							// Extract phase-plan from plan path
							const planFileName = newPath.split("/").pop() || "";
							const planMatch = planFileName.match(/^([^-]+-\d+)-PLAN\.md$/);
							const phasePlan = planMatch ? planMatch[1] : track.id;
							const newId = `${initiative}--${phasePlan}`;
							console.log(`  ${track.id} → ${newId}`);
							console.log(`    ${track.plan_path} → ${newPath}`);
						}
					}
					return;
				}

				// Step 1: Create specs/{initiative}/
				mkdirSync(specsDir, { recursive: true });
				console.log(`Created: ${specsDir}/`);

				// Step 2: Move .planning/* to specs/{initiative}/
				const items = readdirSync(planningDir);
				for (const item of items) {
					const src = join(planningDir, item);
					const dest = join(specsDir, item);

					// Ensure destination parent exists
					mkdirSync(dirname(dest), { recursive: true });

					renameSync(src, dest);
					console.log(`Moved: ${item}`);
				}

				// Step 3: Update track IDs and plan_path
				const tracks = listRuns();
				let updated = 0;
				for (const track of tracks) {
					if (!track.initiative) {
						// Store old ID for track file cleanup
						const oldId = track.id;

						// Update plan_path
						const oldPath = track.plan_path;
						const newPath = oldPath.replace(
							`${planningDir}/`,
							`specs/${initiative}/`,
						);

						// Extract phase-plan from plan path (e.g., "06.6-24-PLAN.md" → "06.6-24")
						const planFileName = newPath.split("/").pop() || "";
						const planMatch = planFileName.match(/^([^-]+-\d+)-PLAN\.md$/);
						if (!planMatch) {
							console.warn(
								`Skipping ${oldId}: Cannot parse phase-plan from ${planFileName}`,
							);
							continue;
						}
						const phasePlan = planMatch[1];

						// Create proper contract-compliant ID: {initiative}--{phase}-{plan}
						const newId = `${initiative}--${phasePlan}`;

						// Create updated run
						const updatedRun: Run = {
							...track,
							id: newId,
							initiative,
							plan_path: newPath,
							updated: new Date().toISOString(),
						};

						// Save with new ID (creates new file)
						saveRun(updatedRun);

						// Remove old run file (fix: was looking in tracks/, should be runs/)
						const oldRunPath = `.tiller/runs/${oldId}.json`;
						if (existsSync(oldRunPath)) {
							unlinkSync(oldRunPath);
						}

						console.log(`Updated track: ${oldId} → ${newId}`);
						console.log(`Migrated: ${newId} → ${oldRunPath} deleted`);
						updated++;
					}
				}

				console.log(`\nMigration complete:`);
				console.log(`  - Directory: ${specsDir}/`);
				console.log(`  - Runs updated: ${updated}`);
				console.log(`\nOptional: rm -rf ${planningDir}/ (now empty)`);
			},
		);
}

export function registerMigrateRollbackCommand(program: Command): void {
	program
		.command("migrate-rollback")
		.description("Rollback the last ID migration")
		.action(() => {
			console.log("Rolling back migration...\n");

			const snapshotPath = join(RUNS_DIR, "..", ".migration-snapshot.json");

			try {
				const result = rollbackMigration(snapshotPath);
				console.log(`\nRollback complete: ${result.restored} runs restored`);

				// Export to JSONL
				console.log("\nExporting to runs.jsonl...");
				const { count } = exportRunsToJsonl(getRunsJsonlPath());
				console.log(`Exported ${count} runs`);
			} catch (err) {
				if (err instanceof Error) {
					console.error(`Error: ${err.message}`);
				} else {
					console.error("Unknown error during rollback");
				}
				process.exit(1);
			}
		});
}
