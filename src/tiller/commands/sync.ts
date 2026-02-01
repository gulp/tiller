/**
 * tiller sync command - JSONL-based run synchronization
 *
 * Enables git-tracked sharing of runs across machines.
 * Following beads pattern: JSONL as sync format, JSON files as local storage.
 */

import type { Command } from "commander";
import {
	exportRunsToJsonl,
	getRunsJsonlPath,
	importRunsFromJsonl,
} from "../state/run.js";

export function registerSyncCommand(program: Command): void {
	program
		.command("sync")
		.description("Synchronize runs with JSONL file for git tracking")
		.option("--export", "Export only (local → runs.jsonl)")
		.option("--import", "Import only (runs.jsonl → local)")
		.option("--dry-run", "Show what would change without making changes")
		.option("--json", "Output as JSON")
		.action(
			(options: {
				export?: boolean;
				import?: boolean;
				dryRun?: boolean;
				json?: boolean;
			}) => {
				const jsonlPath = getRunsJsonlPath();

				// Determine operation mode
				const exportOnly = options.export && !options.import;
				const importOnly = options.import && !options.export;
				const bidirectional = !options.export && !options.import;

				const result: {
					operation: string;
					jsonl_path: string;
					import?: { created: number; updated: number; unchanged: number; skipped: number };
					export?: { count: number };
				} = {
					operation: exportOnly
						? "export"
						: importOnly
							? "import"
							: "bidirectional",
					jsonl_path: jsonlPath,
				};

				// Import phase (if not export-only)
				if (!exportOnly) {
					if (options.dryRun) {
						// Just check what would be imported
						const stats = importRunsFromJsonl(jsonlPath);
						result.import = stats;
					} else {
						const stats = importRunsFromJsonl(jsonlPath);
						result.import = stats;
					}
				}

				// Export phase (if not import-only)
				if (!importOnly && !options.dryRun) {
					const exportResult = exportRunsToJsonl(jsonlPath);
					result.export = exportResult;
				}

				// Output
				if (options.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				// Human-readable output
				console.log(`tiller sync (${result.operation})`);
				console.log(`  JSONL: ${jsonlPath}`);

				if (result.import) {
					const { created, updated, unchanged, skipped } = result.import;
					if (created + updated + skipped === 0 && unchanged === 0) {
						console.log(`  Import: No runs.jsonl found or empty`);
					} else {
						console.log(
							`  Import: ${created} created, ${updated} updated, ${unchanged} unchanged${skipped > 0 ? `, ${skipped} skipped` : ""}`,
						);
					}
				}

				if (result.export) {
					console.log(`  Export: ${result.export.count} runs written`);
				}

				if (options.dryRun) {
					console.log(`\n  (dry-run - no changes made)`);
				}
			},
		);
}
