/**
 * tiller worktree commands - Managed git worktree creation with tiller redirect
 *
 * Following beads pattern: worktrees share main repo's .tiller/ via redirect file.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Command } from "commander";
import {
	CORE_PATHS,
	TILLER_DIR_NAME,
	getTillerRedirectInfo,
} from "../state/paths.js";
import { listRuns } from "../state/run.js";

interface WorktreeInfo {
	path: string;
	branch: string;
	commit: string;
	isMain: boolean;
	tillerStatus: "main" | "redirected" | "not_configured";
}

/**
 * Parse git worktree list --porcelain output
 */
function parseWorktreeList(): WorktreeInfo[] {
	try {
		const output = execSync("git worktree list --porcelain", {
			encoding: "utf-8",
		});

		const worktrees: WorktreeInfo[] = [];
		let current: Partial<WorktreeInfo> = {};

		for (const line of output.split("\n")) {
			if (line.startsWith("worktree ")) {
				if (current.path) {
					worktrees.push(current as WorktreeInfo);
				}
				current = { path: line.slice(9) };
			} else if (line.startsWith("HEAD ")) {
				current.commit = line.slice(5, 12); // Short commit
			} else if (line.startsWith("branch ")) {
				current.branch = line.slice(7).replace("refs/heads/", "");
			} else if (line === "bare") {
				current.branch = "(bare)";
			} else if (line === "detached") {
				current.branch = "(detached)";
			}
		}

		if (current.path) {
			worktrees.push(current as WorktreeInfo);
		}

		// Determine tiller status for each worktree
		const mainRepoPath = CORE_PATHS.PROJECT_ROOT;
		for (const wt of worktrees) {
			wt.isMain = wt.path === mainRepoPath;
			if (wt.isMain) {
				wt.tillerStatus = "main";
			} else {
				const redirectPath = join(wt.path, TILLER_DIR_NAME, "redirect");
				wt.tillerStatus = existsSync(redirectPath)
					? "redirected"
					: "not_configured";
			}
		}

		return worktrees;
	} catch {
		return [];
	}
}

/**
 * Get default worktree path: ../<repo-name>.worktrees/<name>
 */
function getDefaultWorktreePath(name: string): string {
	const repoRoot = CORE_PATHS.PROJECT_ROOT;
	const repoName = basename(repoRoot);
	const worktreesDir = join(dirname(repoRoot), `${repoName}.worktrees`);
	return join(worktreesDir, name);
}

export function registerWorktreeCommand(program: Command): void {
	const worktree = program
		.command("worktree")
		.description("Manage git worktrees with tiller redirect setup");

	// ============================================
	// tiller worktree create <name>
	// ============================================
	worktree
		.command("create <name>")
		.description("Create a worktree with tiller redirect to main repo")
		.option("-b, --branch <branch>", "Create new branch with this name")
		.option("-p, --path <path>", "Custom worktree path")
		.option("--json", "Output as JSON")
		.action(
			(
				name: string,
				options: { branch?: string; path?: string; json?: boolean },
			) => {
				const worktreePath = options.path || getDefaultWorktreePath(name);
				const mainTillerDir = CORE_PATHS.TILLER_DIR;

				// Check if worktree already exists
				if (existsSync(worktreePath)) {
					if (options.json) {
						console.log(
							JSON.stringify({ error: "Path already exists", path: worktreePath }, null, 2),
						);
					} else {
						console.error(`Error: Path already exists: ${worktreePath}`);
					}
					process.exit(1);
				}

				// Create parent directory if needed
				const parentDir = dirname(worktreePath);
				if (!existsSync(parentDir)) {
					mkdirSync(parentDir, { recursive: true });
				}

				// Build git worktree add command
				const branchArg = options.branch ? `-b ${options.branch}` : "";
				const gitCmd = `git worktree add ${branchArg} "${worktreePath}"`.trim();

				try {
					execSync(gitCmd, { stdio: "pipe" });
				} catch (e) {
					const err = e as { stderr?: Buffer };
					if (options.json) {
						console.log(
							JSON.stringify(
								{
									error: "Failed to create worktree",
									details: err.stderr?.toString() || String(e),
								},
								null,
								2,
							),
						);
					} else {
						console.error(`Error creating worktree: ${err.stderr?.toString() || e}`);
					}
					process.exit(1);
				}

				// Create .tiller/redirect in the new worktree
				const wtTillerDir = join(worktreePath, TILLER_DIR_NAME);
				mkdirSync(wtTillerDir, { recursive: true });

				// Calculate relative path from worktree's .tiller/ to main repo's .tiller/
				const relativePath = relative(wtTillerDir, mainTillerDir);

				// Write redirect directly (can't use createTillerRedirect as it uses
				// module-level LOCAL_TILLER_DIR which points to main repo)
				const { writeFileSync } = require("node:fs");
				writeFileSync(join(wtTillerDir, "redirect"), relativePath + "\n");

				const result = {
					created: true,
					name,
					path: worktreePath,
					branch: options.branch || "(current)",
					redirect: relativePath,
					main_tiller: mainTillerDir,
				};

				if (options.json) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					console.log(`✓ Created worktree: ${name}`);
					console.log(`  Path: ${worktreePath}`);
					console.log(`  Branch: ${result.branch}`);
					console.log(`  Redirect: ${relativePath}`);
					console.log(`\nTo use: cd ${worktreePath}`);
				}
			},
		);

	// ============================================
	// tiller worktree list
	// ============================================
	worktree
		.command("list")
		.description("List all git worktrees with tiller status")
		.option("--json", "Output as JSON")
		.action((options: { json?: boolean }) => {
			const worktrees = parseWorktreeList();

			if (options.json) {
				console.log(JSON.stringify({ worktrees }, null, 2));
				return;
			}

			if (worktrees.length === 0) {
				console.log("No worktrees found.");
				return;
			}

			console.log("Worktrees:\n");
			for (const wt of worktrees) {
				const status =
					wt.tillerStatus === "main"
						? "[main]"
						: wt.tillerStatus === "redirected"
							? "[redirected]"
							: "[not configured]";
				console.log(`  ${wt.path}`);
				console.log(`    Branch: ${wt.branch}  ${status}`);
			}
		});

	// ============================================
	// tiller worktree remove <name>
	// ============================================
	worktree
		.command("remove <name>")
		.description("Remove a worktree")
		.option("-f, --force", "Force removal even with uncommitted changes")
		.option("--json", "Output as JSON")
		.action((name: string, options: { force?: boolean; json?: boolean }) => {
			const worktrees = parseWorktreeList();

			// Find worktree by name (match path ending)
			const wt = worktrees.find(
				(w) => basename(w.path) === name || w.path === name,
			);

			if (!wt) {
				if (options.json) {
					console.log(
						JSON.stringify({ error: "Worktree not found", name }, null, 2),
					);
				} else {
					console.error(`Error: Worktree not found: ${name}`);
					console.error("Available worktrees:");
					for (const w of worktrees) {
						console.error(`  ${basename(w.path)}`);
					}
				}
				process.exit(1);
			}

			if (wt.isMain) {
				if (options.json) {
					console.log(
						JSON.stringify({ error: "Cannot remove main repository" }, null, 2),
					);
				} else {
					console.error("Error: Cannot remove the main repository worktree.");
				}
				process.exit(1);
			}

			// Run git worktree remove
			const forceArg = options.force ? "--force" : "";
			const gitCmd = `git worktree remove ${forceArg} "${wt.path}"`.trim();

			try {
				execSync(gitCmd, { stdio: "pipe" });
			} catch (e) {
				const err = e as { stderr?: Buffer };
				if (options.json) {
					console.log(
						JSON.stringify(
							{
								error: "Failed to remove worktree",
								details: err.stderr?.toString() || String(e),
								hint: "Use --force to override",
							},
							null,
							2,
						),
					);
				} else {
					console.error(`Error removing worktree: ${err.stderr?.toString() || e}`);
					console.error("Hint: Use --force to override safety checks.");
				}
				process.exit(1);
			}

			if (options.json) {
				console.log(JSON.stringify({ removed: true, path: wt.path }, null, 2));
			} else {
				console.log(`✓ Removed worktree: ${wt.path}`);
			}
		});

	// ============================================
	// tiller worktree info
	// ============================================
	worktree
		.command("info")
		.description("Show worktree info for current directory")
		.option("--json", "Output as JSON")
		.action((options: { json?: boolean }) => {
			const redirectInfo = getTillerRedirectInfo();
			const worktrees = parseWorktreeList();
			const runs = listRuns();

			const activeRuns = runs.filter((r) => r.state.startsWith("active"));
			const readyRuns = runs.filter((r) => r.state === "ready");

			const info = {
				is_worktree: redirectInfo.isRedirect,
				local_tiller: redirectInfo.localDir,
				target_tiller: redirectInfo.targetDir,
				redirect_path: redirectInfo.redirectTarget,
				worktree_count: worktrees.length,
				runs: {
					total: runs.length,
					active: activeRuns.length,
					ready: readyRuns.length,
				},
			};

			if (options.json) {
				console.log(JSON.stringify(info, null, 2));
				return;
			}

			if (redirectInfo.isRedirect) {
				console.log("Worktree (redirected)\n");
				console.log(`  Local .tiller: ${redirectInfo.localDir}`);
				console.log(`  Redirect to:   ${redirectInfo.redirectTarget}`);
				console.log(`  Resolved:      ${redirectInfo.targetDir}`);
			} else {
				console.log("Main repository\n");
				console.log(`  .tiller: ${redirectInfo.targetDir}`);

				const linkedWorktrees = worktrees.filter((w) => !w.isMain);
				if (linkedWorktrees.length > 0) {
					console.log(`\nLinked worktrees (${linkedWorktrees.length}):`);
					for (const wt of linkedWorktrees) {
						const status = wt.tillerStatus === "redirected" ? "✓" : "○";
						console.log(`  ${status} ${basename(wt.path)} (${wt.branch})`);
					}
				}
			}

			console.log(`\nRuns: ${runs.length} total, ${activeRuns.length} active, ${readyRuns.length} ready`);
		});

	// ============================================
	// tiller worktree configure <name>
	// ============================================
	worktree
		.command("configure <name>")
		.description("Add tiller redirect to an existing worktree")
		.option("--json", "Output as JSON")
		.action((name: string, options: { json?: boolean }) => {
			const worktrees = parseWorktreeList();
			const mainTillerDir = CORE_PATHS.TILLER_DIR;

			// Find worktree by name
			const wt = worktrees.find(
				(w) => basename(w.path) === name || w.path === name,
			);

			if (!wt) {
				if (options.json) {
					console.log(
						JSON.stringify({ error: "Worktree not found", name }, null, 2),
					);
				} else {
					console.error(`Error: Worktree not found: ${name}`);
					console.error("Available worktrees:");
					for (const w of worktrees) {
						console.error(`  ${basename(w.path)}`);
					}
				}
				process.exit(1);
			}

			if (wt.isMain) {
				if (options.json) {
					console.log(
						JSON.stringify({ error: "Cannot configure main repository" }, null, 2),
					);
				} else {
					console.error("Error: Cannot configure the main repository.");
				}
				process.exit(1);
			}

			if (wt.tillerStatus === "redirected") {
				if (options.json) {
					console.log(
						JSON.stringify({ error: "Worktree already configured", path: wt.path }, null, 2),
					);
				} else {
					console.error(`Error: Worktree already configured: ${wt.path}`);
				}
				process.exit(1);
			}

			// Create .tiller/redirect in the worktree
			const wtTillerDir = join(wt.path, TILLER_DIR_NAME);

			// Calculate relative path from worktree's .tiller/ to main repo's .tiller/
			const relativePath = relative(wtTillerDir, mainTillerDir);

			// Backup existing .tiller if it has data
			const existingTillerDir = existsSync(wtTillerDir);
			if (existingTillerDir) {
				const runsDir = join(wtTillerDir, "runs");
				const hasRuns = existsSync(runsDir) && readdirSync(runsDir).length > 0;
				if (hasRuns) {
					if (options.json) {
						console.log(
							JSON.stringify({
								error: "Worktree has existing .tiller data",
								path: wt.path,
								hint: "Backup or remove .tiller/runs first",
							}, null, 2),
						);
					} else {
						console.error(`Error: Worktree has existing .tiller data: ${wt.path}`);
						console.error("Hint: Backup or remove .tiller/runs first");
					}
					process.exit(1);
				}
			}

			// Create/overwrite redirect
			if (!existingTillerDir) {
				mkdirSync(wtTillerDir, { recursive: true });
			}

			const { writeFileSync } = require("node:fs");
			writeFileSync(join(wtTillerDir, "redirect"), relativePath + "\n");

			const result = {
				configured: true,
				name,
				path: wt.path,
				redirect: relativePath,
				main_tiller: mainTillerDir,
			};

			if (options.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				console.log(`✓ Configured worktree: ${name}`);
				console.log(`  Path: ${wt.path}`);
				console.log(`  Redirect: ${relativePath}`);
			}
		});
}
