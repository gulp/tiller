/**
 * Migration utilities for tiller state
 *
 * All migrations must be idempotent (safe to run multiple times).
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { logEvent } from "./events.js";
import { CORE_PATHS } from "./paths.js";
import type { Run } from "../types/index.js";

// Derive from centralized CORE_PATHS
const { RUNS_DIR, LEGACY_TRACKS_DIR } = CORE_PATHS;

/**
 * Migrate tracks/ directory to runs/ (ADR-0004)
 *
 * Idempotent: Only runs if tracks/ exists and runs/ doesn't.
 * - Moves .tiller/tracks/ → .tiller/runs/
 * - Updates JSON files: track_id → run_id (data moves forward)
 * - Logs structural event
 *
 * @returns true if migration was performed, false if skipped
 */
export function migrateTracksToRuns(): boolean {
	// Skip if already migrated (runs/ exists) or nothing to migrate (no tracks/)
	if (!existsSync(LEGACY_TRACKS_DIR)) {
		return false;
	}

	if (existsSync(RUNS_DIR)) {
		// Both exist - may be partial migration, complete it
		completeMigration();
		return false;
	}

	// Perform migration
	mkdirSync(RUNS_DIR, { recursive: true });

	const files = readdirSync(LEGACY_TRACKS_DIR).filter((f) =>
		f.endsWith(".json"),
	);

	let migratedCount = 0;

	for (const file of files) {
		const oldPath = join(LEGACY_TRACKS_DIR, file);
		const newPath = join(RUNS_DIR, file);

		try {
			const content = readFileSync(oldPath, "utf-8");
			const data = JSON.parse(content);

			// Migrate field names (accept old, emit new)
			if (data.track_id && !data.id) {
				data.id = data.track_id;
				delete data.track_id;
			}

			writeFileSync(newPath, JSON.stringify(data, null, 2));

			// Remove original file after successful migration
			rmSync(oldPath);

			migratedCount++;
		} catch (err) {
			// Log but continue - don't fail entire migration for one bad file
			console.error(`Warning: Could not migrate ${file}: ${err}`);
		}
	}

	// Clean up legacy directory after successful migration
	cleanupLegacyTracks();

	// Log structural event
	logEvent({
		event: "migration",
		migration: "tracks_to_runs",
		files_migrated: migratedCount,
		message: "MIGRATION tracks→runs applied",
	});

	return true;
}

/**
 * Complete a partial migration where both tracks/ and runs/ exist
 * Moves any remaining files from tracks/ to runs/ and cleans up
 */
function completeMigration(): void {
	if (!existsSync(LEGACY_TRACKS_DIR)) {
		return;
	}

	try {
		const remaining = readdirSync(LEGACY_TRACKS_DIR).filter((f) =>
			f.endsWith(".json"),
		);

		for (const file of remaining) {
			const oldPath = join(LEGACY_TRACKS_DIR, file);
			const newPath = join(RUNS_DIR, file);

			// Only migrate if not already in runs/
			if (!existsSync(newPath)) {
				try {
					const content = readFileSync(oldPath, "utf-8");
					const data = JSON.parse(content);

					// Migrate field names
					if (data.track_id && !data.id) {
						data.id = data.track_id;
						delete data.track_id;
					}

					writeFileSync(newPath, JSON.stringify(data, null, 2));
				} catch {
					// Skip problematic files
				}
			}

			// Remove from tracks/ regardless (runs/ has the copy)
			try {
				rmSync(oldPath);
			} catch {
				// Ignore removal errors
			}
		}

		// Clean up empty directory
		cleanupLegacyTracks();
	} catch {
		// Ignore errors during cleanup
	}
}

/**
 * Remove legacy tracks/ directory if empty
 */
function cleanupLegacyTracks(): void {
	if (!existsSync(LEGACY_TRACKS_DIR)) {
		return;
	}

	try {
		const remaining = readdirSync(LEGACY_TRACKS_DIR);
		if (remaining.length === 0) {
			rmSync(LEGACY_TRACKS_DIR, { recursive: true });
		}
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Generate unique run ID (duplicated from track.ts to avoid circular import)
 */
function generateRunIdForMigration(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let id = "run-";
	for (let i = 0; i < 6; i++) {
		id += chars[Math.floor(Math.random() * chars.length)];
	}
	return id;
}

/**
 * Migration snapshot for rollback support
 */
interface MigrationSnapshot {
	timestamp: string;
	migrations: Array<{
		newId: string;
		oldId: string;
		oldFilename: string;
		runData: Run;
	}>;
}

/**
 * Create a migration snapshot for rollback
 */
export function createMigrationSnapshot(
	migrations: Array<{ oldId: string; newId: string; oldPath: string; data: Run }>,
): string {
	const snapshot: MigrationSnapshot = {
		timestamp: new Date().toISOString(),
		migrations: migrations.map((m) => ({
			newId: m.newId,
			oldId: m.oldId,
			oldFilename: m.oldPath,
			runData: m.data,
		})),
	};

	const snapshotPath = join(RUNS_DIR, "..", ".migration-snapshot.json");
	writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
	console.log(`Migration snapshot saved to: ${snapshotPath}`);
	return snapshotPath;
}

/**
 * Rollback migration from snapshot
 */
export function rollbackMigration(snapshotPath: string): { restored: number } {
	if (!existsSync(snapshotPath)) {
		throw new Error("No migration snapshot found at: " + snapshotPath);
	}

	const snapshot: MigrationSnapshot = JSON.parse(
		readFileSync(snapshotPath, "utf-8"),
	);

	let restored = 0;
	for (const m of snapshot.migrations) {
		const newPath = join(RUNS_DIR, `${m.newId}.json`);
		const oldPath = join(RUNS_DIR, m.oldFilename);

		// Restore old filename and ID
		const data = { ...m.runData, id: m.oldId };
		writeFileSync(oldPath, JSON.stringify(data, null, 2));

		// Remove new file if it exists
		if (existsSync(newPath)) {
			rmSync(newPath);
		}

		console.log(`Restored: ${m.newId} → ${m.oldId}`);
		restored++;
	}

	// Remove snapshot after successful rollback
	rmSync(snapshotPath);

	logEvent({
		event: "migration",
		migration: "rollback_immutable_ids",
		files_restored: restored,
		message: "ROLLBACK immutable IDs → contract format",
	});

	return { restored };
}

/**
 * Validate system state before migration
 */
function validatePreMigration(): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	// Check 1: Verify .tiller/runs directory exists
	if (!existsSync(RUNS_DIR)) {
		errors.push("No .tiller/runs directory found");
		return { valid: false, errors };
	}

	// Check 2: Count contract-format files
	const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	const contractFiles = files.filter((f) =>
		f.match(/^[a-z0-9-]+--[\d.]+(?:-[\d.]+)?\.json$/),
	);

	if (contractFiles.length === 0) {
		errors.push(
			"No contract-format run files found - migration may already be complete",
		);
	}

	// Informational: Check if runs.jsonl exists
	const jsonlPath = join(RUNS_DIR, "..", "runs.jsonl");
	if (!existsSync(jsonlPath)) {
		console.warn(
			"Warning: runs.jsonl not found - will be created after migration",
		);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Validate system state after migration
 */
function validatePostMigration(originalCount: number): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	// Check 1: Verify no contract-format files remain
	const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	const remainingContract = files.filter((f) =>
		f.match(/^[a-z0-9-]+--[\d.]+(?:-[\d.]+)?\.json$/),
	);

	if (remainingContract.length > 0) {
		errors.push(
			`${remainingContract.length} contract-format files remain: ${remainingContract.slice(0, 5).join(", ")}${remainingContract.length > 5 ? "..." : ""}`,
		);
	}

	// Check 2: Verify count matches
	const newCount = files.length;
	if (newCount !== originalCount) {
		errors.push(
			`Run count mismatch: expected ${originalCount}, got ${newCount}`,
		);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Migrate plan-ref-named files to immutable run-<id>.json format
 *
 * Files like "06.6-23.json" become "run-abc123.json" because:
 * - Plan refs are mutable (renumbering, phase shifts)
 * - File IDs should be immutable
 * - plan_ref is derived from plan_path at read-time
 *
 * Idempotent: Only renames files that don't already have run- or track- prefix.
 *
 * @returns number of files migrated
 */
export function migratePlanRefFilenames(dryRun: boolean = false): {
	migratedCount: number;
	migrations: Array<{ oldId: string; newId: string; oldPath: string; newPath: string }>;
	errors?: string[];
} {
	const migrations: Array<{ oldId: string; newId: string; oldPath: string; newPath: string }> = [];

	// Pre-migration validation
	const preValidation = validatePreMigration();
	if (!preValidation.valid) {
		console.error("Pre-migration validation failed:");
		for (const error of preValidation.errors) {
			console.error(`  - ${error}`);
		}
		return { migratedCount: 0, migrations, errors: preValidation.errors };
	}

	if (!existsSync(RUNS_DIR)) {
		return { migratedCount: 0, migrations };
	}

	const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	const originalCount = files.length;

	// Collect snapshot data for rollback
	const snapshotData: Array<{ oldId: string; newId: string; oldPath: string; data: Run }> = [];
	const migrationPlan: Array<{
		file: string;
		oldId: string;
		newId: string;
		oldPath: string;
		newPath: string;
		data: Run;
	}> = [];

	// First pass: collect migration data
	for (const file of files) {
		// Skip files that already have immutable ID prefix
		if (file.startsWith("run-")) {
			continue;
		}

		// Recognize contract format: {initiative}--{phase}-{plan}.json
		const isContractFormat = file.match(/^[a-z0-9-]+--[\d.]+(?:-[\d.]+)?\.json$/);

		// Skip track- prefix (legacy) and non-contract files
		if (file.startsWith("track-") && !isContractFormat) {
			continue;
		}

		const oldPath = join(RUNS_DIR, file);

		try {
			const content = readFileSync(oldPath, "utf-8");
			const data = JSON.parse(content) as Run;

			// Generate new immutable ID
			const newId = generateRunIdForMigration();
			const newPath = join(RUNS_DIR, `${newId}.json`);

			// Store old ID before modifying
			const oldId = data.id;

			// Track migration
			migrations.push({ oldId, newId, oldPath: file, newPath: `${newId}.json` });

			// Collect snapshot data (with original data before modification)
			snapshotData.push({ oldId, newId, oldPath: file, data: { ...data } });

			// Prepare updated data
			const updatedData = { ...data, id: newId, updated: new Date().toISOString() };

			// Add to migration plan
			migrationPlan.push({
				file,
				oldId,
				newId,
				oldPath,
				newPath,
				data: updatedData,
			});
		} catch (err) {
			console.error(`Warning: Could not process ${file}: ${err}`);
		}
	}

	// Create snapshot before any destructive operations
	if (migrationPlan.length > 0 && !dryRun) {
		createMigrationSnapshot(snapshotData);
	}

	// Second pass: perform actual migration
	let migratedCount = 0;
	if (!dryRun) {
		for (const plan of migrationPlan) {
			try {
				// Write to new location
				writeFileSync(plan.newPath, JSON.stringify(plan.data, null, 2));

				// Remove old file
				rmSync(plan.oldPath);

				// Log individual migration for debugging
				console.error(`Migrated: ${plan.oldId} → ${plan.newId}`);
				migratedCount++;
			} catch (err) {
				console.error(`Warning: Could not migrate ${plan.file}: ${err}`);
			}
		}
	} else {
		migratedCount = migrationPlan.length;
	}

	if (migratedCount > 0 && !dryRun) {

		logEvent({
			event: "migration",
			migration: "planref_to_immutable_ids",
			files_migrated: migratedCount,
			message: "MIGRATION plan-ref filenames → run-<id>.json applied",
		});

		// Post-migration validation
		const postValidation = validatePostMigration(originalCount);
		if (!postValidation.valid) {
			console.error("\nPost-migration validation warnings:");
			for (const error of postValidation.errors) {
				console.error(`  - ${error}`);
			}
			return {
				migratedCount,
				migrations,
				errors: postValidation.errors,
			};
		}
	}

	return { migratedCount, migrations };
}

/**
 * Run all pending migrations
 * Called during tiller initialization (ensureTillerDir)
 */
export function runMigrations(): void {
	migrateTracksToRuns();

	// NOTE: migratePlanRefFilenames() is permanently disabled
	// It conflicts with v0.2.0 contract format ({initiative}--{phase}-{plan})
	// and would incorrectly convert valid contract IDs to legacy run-{random} format.
	// For v0.1.0 public release, this migration is not needed.
}
