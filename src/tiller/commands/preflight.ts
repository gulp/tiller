/**
 * Tiller preflight command - Pre-completion codebase checks
 *
 * Usage: tiller preflight           (run tsc + git status)
 *        tiller preflight --build   (also run full build)
 *        tiller preflight --no-git  (skip git status check)
 */

import { execSync } from "node:child_process";
import type { Command } from "commander";

interface PreflightResult {
	types: { ok: boolean; output?: string } | null;
	git: { ok: boolean; clean: boolean; output?: string } | null;
	build: { ok: boolean; output?: string } | null;
	ok: boolean;
}

function runCommand(cmd: string): { ok: boolean; output: string } {
	try {
		const output = execSync(cmd, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 120000, // 2 minutes
		});
		return { ok: true, output: output.trim() };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		const output =
			(err.stdout || "") + (err.stderr || "") ||
			err.message ||
			"Command failed";
		return { ok: false, output: output.trim() };
	}
}

function checkTypes(quiet: boolean): { ok: boolean; output?: string } {
	if (!quiet) console.log("Running type check...");
	const result = runCommand("tsc --noEmit");
	if (!quiet) {
		if (result.ok) {
			console.log("  Types OK");
		} else {
			console.log("  Type errors:");
			const lines = result.output.split("\n").slice(0, 10);
			for (const line of lines) {
				console.log(`    ${line}`);
			}
			if (result.output.split("\n").length > 10) {
				console.log("    ...(truncated)");
			}
		}
	}
	return result;
}

function checkGit(quiet: boolean): {
	ok: boolean;
	clean: boolean;
	output?: string;
} {
	if (!quiet) console.log("Checking git status...");
	const result = runCommand("git status --porcelain");

	if (!result.ok) {
		if (!quiet) console.log("  Git check failed");
		return { ok: false, clean: false, output: result.output };
	}

	const clean = result.output.length === 0;
	if (!quiet) {
		if (clean) {
			console.log("  Working tree clean");
		} else {
			const lines = result.output.split("\n").filter(Boolean);
			console.log(`  ${lines.length} uncommitted change(s):`);
			for (const line of lines.slice(0, 5)) {
				console.log(`    ${line}`);
			}
			if (lines.length > 5) {
				console.log(`    ...(${lines.length - 5} more)`);
			}
		}
	}

	return { ok: true, clean, output: result.output };
}

function checkBuild(quiet: boolean): { ok: boolean; output?: string } {
	if (!quiet) console.log("Running full build...");
	const result = runCommand("bun run build");
	if (!quiet) {
		if (result.ok) {
			console.log("  Build OK");
		} else {
			console.log("  Build failed:");
			const lines = result.output.split("\n").slice(0, 10);
			for (const line of lines) {
				console.log(`    ${line}`);
			}
			if (result.output.split("\n").length > 10) {
				console.log("    ...(truncated)");
			}
		}
	}
	return result;
}

export function registerPreflightCommand(program: Command): void {
	program
		.command("preflight")
		.description("Pre-completion checks (types, git status, build)")
		.option("--no-types", "Skip type checking")
		.option("--no-git", "Skip git status check")
		.option("--build", "Run full build (slower)")
		.option("--json", "Output as JSON")
		.option("--strict", "Fail on uncommitted changes (default: warn only)")
		.action(
			(opts: {
				types: boolean;
				git: boolean;
				build?: boolean;
				json?: boolean;
				strict?: boolean;
			}) => {
				const quiet = opts.json ?? false;
				const result: PreflightResult = {
					types: null,
					git: null,
					build: null,
					ok: true,
				};

				if (!quiet) {
					console.log("Preflight checks...\n");
				}

				// Type check
				if (opts.types) {
					const typesResult = checkTypes(quiet);
					result.types = typesResult;
					if (!typesResult.ok) {
						result.ok = false;
					}
				}

				// Git status
				if (opts.git) {
					const gitResult = checkGit(quiet);
					result.git = gitResult;
					if (!gitResult.ok) {
						result.ok = false;
					} else if (opts.strict && !gitResult.clean) {
						result.ok = false;
					}
				}

				// Full build (optional)
				if (opts.build) {
					const buildResult = checkBuild(quiet);
					result.build = buildResult;
					if (!buildResult.ok) {
						result.ok = false;
					}
				}

				// Output
				if (quiet) {
					console.log(JSON.stringify(result, null, 2));
				} else {
					console.log("");
					if (result.ok) {
						console.log("All checks passed");
					} else {
						console.log("Some checks failed");
					}
				}

				if (!result.ok) {
					process.exit(1);
				}
			},
		);
}
