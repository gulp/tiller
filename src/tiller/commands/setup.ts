/**
 * Tiller setup command - Install hooks for Claude Code
 *
 * Usage: tiller setup claude
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { CORE_PATHS } from "../state/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, "..", "templates", "bootstrap");

const TILLER_PRIME = "tiller prime";

type Scope = "local" | "user" | "project";

function getSettingsPath(scope: Scope): string {
	const cwd = process.cwd();
	switch (scope) {
		case "local":
			return join(cwd, ".claude", "settings.local.json");
		case "project":
			return join(cwd, ".claude", "settings.json");
		case "user":
			return join(homedir(), ".claude", "settings.json");
	}
}

interface Hook {
	type: string;
	command: string;
}

interface HookEntry {
	matcher?: string;
	hooks: Hook[];
}

interface ClaudeSettings {
	hooks?: {
		SessionStart?: HookEntry[];
		PreCompact?: HookEntry[];
		[key: string]: HookEntry[] | undefined;
	};
	[key: string]: unknown;
}

function loadSettings(path: string): ClaudeSettings {
	if (!existsSync(path)) {
		return {};
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		// Don't silently return empty - this could cause data loss!
		console.error(
			`Error reading settings from ${path}: ${(e as Error).message}`,
		);
		console.error(`Fix the file manually or back it up before continuing.`);
		process.exit(1);
	}
}

function saveSettings(path: string, settings: ClaudeSettings): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function addHook(
	settings: ClaudeSettings,
	event: string,
	command: string,
	matcher = "",
): boolean {
	if (!settings.hooks) {
		settings.hooks = {};
	}

	const entries = settings.hooks[event] as HookEntry[] | undefined;

	// Check if hook already exists with same command and matcher
	if (
		entries?.some(
			(entry) =>
				entry.matcher === matcher &&
				entry.hooks?.some((h) => h.command === command),
		)
	) {
		return false; // Already exists
	}

	const newEntry: HookEntry = {
		matcher,
		hooks: [
			{
				type: "command",
				command,
			},
		],
	};

	if (!settings.hooks[event]) {
		settings.hooks[event] = [];
	}
	(settings.hooks[event] as HookEntry[]).push(newEntry);
	return true;
}

const TILLER_HOOK_BD_ON_CREATE = "tiller hook bd-on-create";
const TILLER_HOOK_PLAN_ON_WRITE = "tiller hook plan-on-write";

export function registerSetupCommand(program: Command): void {
	const setup = program
		.command("setup")
		.description("Initialize tiller hooks and project structure");

	// Default action (when no subcommand): show help
	setup.action(() => {
		setup.help();
	});

	setup
		.command("claude")
		.description(
			"Install Claude Code hooks (SessionStart, PreCompact, PostToolUse)",
		)
		.option(
			"-s, --scope <scope>",
			"Configuration scope (local, user, project)",
			"local",
		)
		.option("--dry-run", "Show what would be done without making changes")
		.action((opts: { scope: string; dryRun?: boolean }) => {
			const scope = opts.scope as Scope;
			if (!["local", "user", "project"].includes(scope)) {
				console.error(
					`Invalid scope: ${scope}. Must be: local, user, or project`,
				);
				process.exit(1);
			}

			const settingsPath = getSettingsPath(scope);
			const settings = loadSettings(settingsPath);
			const changes: string[] = [];

			// Add to SessionStart
			if (addHook(settings, "SessionStart", TILLER_PRIME)) {
				changes.push("SessionStart: added 'tiller prime'");
			}

			// Add to PreCompact
			if (addHook(settings, "PreCompact", TILLER_PRIME)) {
				changes.push("PreCompact: added 'tiller prime'");
			}

			// Add PostToolUse hooks
			if (addHook(settings, "PostToolUse", TILLER_HOOK_BD_ON_CREATE, "Bash")) {
				changes.push("PostToolUse[Bash]: added 'tiller hook bd-on-create'");
			}
			if (addHook(settings, "PostToolUse", TILLER_HOOK_PLAN_ON_WRITE, "Write")) {
				changes.push("PostToolUse[Write]: added 'tiller hook plan-on-write'");
			}

			if (changes.length === 0) {
				console.log("✓ Claude Code hooks already installed.");
				console.log(`  Scope: ${scope} (${settingsPath})`);
				return;
			}

			if (opts.dryRun) {
				console.log("Would make these changes:");
				for (const change of changes) {
					console.log(`  ${change}`);
				}
				console.log(`\nScope: ${scope}`);
				console.log(`File: ${settingsPath}`);
				return;
			}

			saveSettings(settingsPath, settings);
			console.log("✓ Installed Claude Code hooks:");
			for (const change of changes) {
				console.log(`  ${change}`);
			}
			console.log(`\nScope: ${scope}`);
			console.log(`File: ${settingsPath}`);
			console.log("\nRestart Claude Code for hooks to take effect.");
		});

	// Alias: bootstrap = setup --with-samples
	setup
		.command("bootstrap")
		.description("Initialize with sample files (alias for 'setup --with-samples')")
		.option("--no-with-samples", "Skip sample files (create structure only)")
		.option("--dry-run", "Show what would be created without making changes")
		.option("--init-git", "Initialize git repo if not present")
		.action(
			(opts: { withSamples?: boolean; dryRun?: boolean; initGit?: boolean }) => {
				if (process.env.TILLER_DEBUG) {
					console.error('[DEBUG] bootstrap action opts:', JSON.stringify(opts));
				}
				bootstrapProject({
					dryRun: !!opts.dryRun,
					withSamples: opts.withSamples !== false, // Default to true unless --no-with-samples
					initGit: !!opts.initGit
				});
			},
		);
}

function bootstrapProject(opts: {
	dryRun?: boolean;
	withSamples: boolean;
	initGit: boolean;
}): void {
	// Debug: check what we received
	if (process.env.TILLER_DEBUG) {
		console.error('[DEBUG] bootstrapProject opts:', JSON.stringify(opts));
		console.error('[DEBUG] dryRun type:', typeof opts.dryRun, 'value:', opts.dryRun);
	}

	const cwd = process.cwd();
	const actions: string[] = [];

	// Check what needs to be created
	const tillerDir = relative(cwd, CORE_PATHS.TILLER_DIR);
	const runsDir = relative(cwd, CORE_PATHS.RUNS_DIR);
	const dirs = [
		{ path: tillerDir, desc: "Tiller state directory" },
		{ path: runsDir, desc: "Run state directory" },
		{ path: "plans", desc: "Execution plans directory" },
		{ path: "specs", desc: "Spec proposals directory" },
		{ path: "plans/todos", desc: "Ad-hoc todos directory" },
	];

	for (const { path: dirPath, desc } of dirs) {
		const fullPath = join(cwd, dirPath);
		if (!existsSync(fullPath)) {
			actions.push(`Create ${dirPath}/ (${desc})`);
			if (!opts.dryRun) {
				mkdirSync(fullPath, { recursive: true });
			}
		}
	}

	// Copy config files from templates (if available)
	const templatesAvailable = existsSync(TEMPLATES_DIR);
	if (!templatesAvailable) {
		console.warn(
			"Warning: Bootstrap templates not found. Run 'bun run build' to compile templates.",
		);
		console.warn("Only creating directory structure.");
	}

	if (templatesAvailable) {
	const templateToml = join(TEMPLATES_DIR, "tiller.toml");
	const targetToml = join(CORE_PATHS.TILLER_DIR, "tiller.toml");
	if (!existsSync(targetToml) && existsSync(templateToml)) {
		actions.push(`Create ${relative(cwd, targetToml)}`);
		if (!opts.dryRun) {
			cpSync(templateToml, targetToml);
		}
	}

	const templatePrime = join(TEMPLATES_DIR, "PRIME.md");
	const targetPrime = join(CORE_PATHS.TILLER_DIR, "PRIME.md");
	if (!existsSync(targetPrime) && existsSync(templatePrime)) {
		actions.push(`Create ${relative(cwd, targetPrime)}`);
		if (!opts.dryRun) {
			// Replace {{PROJECT_NAME}} with actual directory name
			const primeContent = readFileSync(templatePrime, "utf-8").replace(
				"{{PROJECT_NAME}}",
				basename(cwd),
			);
			writeFileSync(targetPrime, primeContent);
		}
	}

	// Copy sample run files if with-samples (shows workflow with active and ready runs)
	if (opts.withSamples && templatesAvailable) {
		const templateRunsDir = join(TEMPLATES_DIR, relative(cwd, CORE_PATHS.TILLER_DIR), "runs");
		const targetRunsDir = CORE_PATHS.RUNS_DIR;
		const targetRun1 = join(targetRunsDir, "run-i7934d.json");
		const targetRun2 = join(targetRunsDir, "run-j8k2lp.json");

		if (existsSync(templateRunsDir) && !existsSync(targetRun1) && !existsSync(targetRun2)) {
			actions.push(`Create ${relative(cwd, targetRunsDir)}/*.json (sample run states)`);
			if (!opts.dryRun) {
				cpSync(templateRunsDir, targetRunsDir, { recursive: true });
			}
		}
	}

	// Copy .gitignore template
	const templateGitignore = join(TEMPLATES_DIR, ".gitignore");
	const targetGitignore = join(cwd, ".gitignore");
	const tillerGitignorePattern = `${basename(CORE_PATHS.TILLER_DIR)}/`;
	if (!existsSync(targetGitignore) && existsSync(templateGitignore)) {
		actions.push("Create .gitignore");
		if (!opts.dryRun) {
			cpSync(templateGitignore, targetGitignore);
		}
	} else if (existsSync(targetGitignore) && existsSync(templateGitignore)) {
		// Append tiller entries if not present
		const existing = readFileSync(targetGitignore, "utf-8");
		if (!existing.includes(tillerGitignorePattern)) {
			actions.push("Update .gitignore (add tiller entries)");
			if (!opts.dryRun) {
				const templateContent = readFileSync(templateGitignore, "utf-8");
				writeFileSync(targetGitignore, `${existing}\n${templateContent}`, "utf-8");
			}
		}
	}

	// Sample files - copy from templates
	if (opts.withSamples && templatesAvailable) {
		const templateSpecs = join(TEMPLATES_DIR, "specs");
		const templatePlans = join(TEMPLATES_DIR, "plans");
		const templateSrcSample = join(TEMPLATES_DIR, "src-sample");

		// Copy sample specs (numbered and draft examples)
		const targetSpec1 = join(cwd, "specs", "0001-dark-mode");
		const targetSpec2 = join(cwd, "specs", "hero-section");
		if (!existsSync(targetSpec1) && !existsSync(targetSpec2) && existsSync(templateSpecs)) {
			actions.push("Create specs/0001-dark-mode/ and specs/hero-section/");
			if (!opts.dryRun) {
				cpSync(templateSpecs, join(cwd, "specs"), { recursive: true });
			}
		}

		// Copy sample plan
		const targetPlan = join(cwd, "plans", "example-init");
		if (!existsSync(targetPlan) && existsSync(templatePlans)) {
			actions.push("Create plans/example-init/ (with 01-phase/)");
			if (!opts.dryRun) {
				cpSync(templatePlans, join(cwd, "plans"), {
					recursive: true,
					filter: (src) => !src.includes("/todos"), // Don't overwrite todos/
				});
			}
		}

		// Copy src-sample/
		const targetSrcSample = join(cwd, "src-sample");
		if (!existsSync(targetSrcSample) && existsSync(templateSrcSample)) {
			actions.push("Create src-sample/ (with demo.html)");
			if (!opts.dryRun) {
				cpSync(templateSrcSample, targetSrcSample, { recursive: true });
			}
		}

		// Copy QUICKSTART.md
		const templateQuickstart = join(TEMPLATES_DIR, "QUICKSTART.md");
		const targetQuickstart = join(cwd, "QUICKSTART.md");
		if (!existsSync(targetQuickstart) && existsSync(templateQuickstart)) {
			actions.push("Create QUICKSTART.md");
			if (!opts.dryRun) {
				cpSync(templateQuickstart, targetQuickstart);
			}
		}
	}

	// Close templatesAvailable block
	}

	// Git init
	if (opts.initGit && !existsSync(join(cwd, ".git"))) {
		actions.push("Initialize git repository");
		if (!opts.dryRun) {
			execSync("git init", { stdio: "inherit" });
		}
	}

	// Report results
	if (opts.dryRun) {
		console.log("Would create:");
		for (const action of actions) {
			console.log(`  ${action}`);
		}
		if (actions.length === 0) {
			console.log("  Nothing (all files already exist)");
		}
		return;
	}

	if (actions.length === 0) {
		console.log("✓ Project already bootstrapped");
		console.log("  All directories and sample files exist");
		return;
	}

	console.log("✓ Bootstrapped tiller project:");
	for (const action of actions) {
		console.log(`  ${action}`);
	}

	if (opts.withSamples) {
		console.log("\nNext steps - Ask Claude:");
		console.log('  "Explain the example files"');
		console.log('  "Run: tiller status"');
		console.log('  "Run: tiller activate 01-01"');
		console.log("\nTo start your own work:");
		console.log('  "Run: ahoy draft my-feature"');
		console.log('  "Then: tiller accept 0001-my-feature --as-initiative my-project"');
		console.log("\nOr explore:");
		console.log("  cat QUICKSTART.md");
	} else {
		console.log("\nNext steps:");
		console.log("  tiller setup --with-samples  # Add example files");
		console.log("  tiller status                # Check current state");
		console.log("  tiller setup claude          # Install Claude Code hooks");
	}
}
