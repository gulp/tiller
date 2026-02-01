/**
 * Tiller configuration management
 *
 * Config priority:
 * 1. .tiller/tiller.toml (new format)
 * 2. .tiller/config.json (legacy, for migration)
 * 3. Default values
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as TOML from "@iarna/toml";
import type { TillerConfig } from "../types/index.js";
import { initDefaultConstitutional } from "./constitutional.js";
import { runMigrations } from "./migration.js";
import {
	CORE_PATHS,
	findProjectRoot,
	guardNestedTiller,
} from "./paths.js";

// Re-export for backward compatibility
export { findProjectRoot };

// Derive from centralized CORE_PATHS
const { PROJECT_ROOT, TILLER_DIR, LOCAL_TILLER_DIR, RUNS_DIR, LEGACY_TRACKS_DIR, IS_REDIRECT, REDIRECT_TARGET } = CORE_PATHS;
const TOML_CONFIG_FILE = join(TILLER_DIR, "tiller.toml");
const JSON_CONFIG_FILE = join(TILLER_DIR, "config.json");

const DEFAULT_CONFIG: TillerConfig = {
	version: "0.2.0",
	paths: {
		plans: "plans",
		specs: "specs",
		default_initiative: "tiller-cli",
		todos: "plans/todos",
	},
	sync: {
		auto_sync_on_status: true,
	},
	workflow: {
		confirmation_prompts: true,
	},
};

/**
 * Ensure .tiller/ directory structure exists
 */
export function ensureTillerDir(): void {
	// Guard against nested .tiller creation
	guardNestedTiller();

	if (!existsSync(TILLER_DIR)) {
		mkdirSync(TILLER_DIR, { recursive: true });
	}

	// Run migrations before creating new directories
	// (e.g., tracks/ → runs/ migration)
	runMigrations();

	if (!existsSync(RUNS_DIR)) {
		mkdirSync(RUNS_DIR, { recursive: true });
	}
	// Initialize default constitutional files
	initDefaultConstitutional();
}

/**
 * Load config from .tiller/tiller.toml or .tiller/config.json
 */
export function loadConfig(): TillerConfig {
	// Try TOML first (new format)
	if (existsSync(TOML_CONFIG_FILE)) {
		try {
			const content = readFileSync(TOML_CONFIG_FILE, "utf-8");
			const parsed = TOML.parse(content) as Partial<TillerConfig>;
			return {
				...DEFAULT_CONFIG,
				...parsed,
				paths: { ...DEFAULT_CONFIG.paths, ...parsed.paths },
				sync: { ...DEFAULT_CONFIG.sync, ...parsed.sync },
				workflow: { ...DEFAULT_CONFIG.workflow, ...parsed.workflow },
			};
		} catch (err) {
			console.warn(
				`Warning: Failed to parse ${TOML_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
			);
			console.warn("Falling back to legacy JSON config or defaults.");
		}
	}

	// Try legacy JSON (deprecated)
	if (existsSync(JSON_CONFIG_FILE)) {
		try {
			const content = readFileSync(JSON_CONFIG_FILE, "utf-8");
			const legacy = JSON.parse(content) as Record<string, unknown>;
			// Migrate legacy format to new structure
			const migrated: TillerConfig = {
				...DEFAULT_CONFIG,
				paths: {
					...DEFAULT_CONFIG.paths,
					plans: (legacy.default_plan_dir as string) || DEFAULT_CONFIG.paths.plans,
				},
				sync: {
					auto_sync_on_status: (legacy.auto_sync_on_status as boolean) ?? DEFAULT_CONFIG.sync.auto_sync_on_status,
				},
				workflow: {
					confirmation_prompts: (legacy.confirmation_prompts as boolean) ?? DEFAULT_CONFIG.workflow.confirmation_prompts,
				},
			};
			// Auto-migrate: save to TOML and remove JSON
			console.warn(`Migrating ${JSON_CONFIG_FILE} → ${TOML_CONFIG_FILE}`);
			saveConfig(migrated);
			const { unlinkSync } = require("node:fs");
			unlinkSync(JSON_CONFIG_FILE);
			console.warn("Migration complete. Legacy config.json removed.");
			return migrated;
		} catch (err) {
			console.warn(
				`Warning: Failed to parse ${JSON_CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
			);
			console.warn("Using default configuration.");
		}
	}

	return DEFAULT_CONFIG;
}

/**
 * Save config to .tiller/tiller.toml
 */
export function saveConfig(config: TillerConfig): void {
	ensureTillerDir();
	const tomlContent = TOML.stringify(config as unknown as TOML.JsonMap);
	writeFileSync(TOML_CONFIG_FILE, tomlContent);
}

/**
 * Initialize config - create defaults if not exist
 */
export function initConfig(): TillerConfig {
	ensureTillerDir();
	if (!existsSync(TOML_CONFIG_FILE) && !existsSync(JSON_CONFIG_FILE)) {
		saveConfig(DEFAULT_CONFIG);
	}
	return loadConfig();
}

/**
 * Get path constants (static paths)
 */
export const PATHS = {
	PROJECT_ROOT,
	TILLER_DIR,
	LOCAL_TILLER_DIR,
	RUNS_DIR,
	LEGACY_TRACKS_DIR,
	IS_REDIRECT,
	REDIRECT_TARGET,
	CONFIG_FILE: TOML_CONFIG_FILE,
	AGENTS_DIR: join(TILLER_DIR, "agents"),
	WORKFLOWS_DIR: join(TILLER_DIR, "workflows"),
	WORKFLOW_INSTANCES_DIR: join(TILLER_DIR, "workflows/instances"),
	HANDS_DIR: join(TILLER_DIR, "hands"),
	MATES_DIR: join(TILLER_DIR, "mates"),
	PRIME_FILE: join(TILLER_DIR, "PRIME.md"),
	PRIME_LOCAL_FILE: join(TILLER_DIR, "PRIME.local.md"),
	PENDING_DIR: join(TILLER_DIR, "pending"),
	BACKUPS_DIR: join(TILLER_DIR, "backups"),
} as const;

/**
 * Get dynamic paths based on config
 */
export function getConfigPaths(): {
	PLANS_DIR: string;
	SPECS_DIR: string;
	DEFAULT_INITIATIVE: string;
	DEFAULT_PLANS_DIR: string;
	TODOS_DIR: string;
} {
	const config = loadConfig();
	return {
		PLANS_DIR: join(PROJECT_ROOT, config.paths.plans),
		SPECS_DIR: join(PROJECT_ROOT, config.paths.specs),
		DEFAULT_INITIATIVE: config.paths.default_initiative,
		DEFAULT_PLANS_DIR: join(PROJECT_ROOT, config.paths.plans, config.paths.default_initiative),
		TODOS_DIR: join(PROJECT_ROOT, config.paths.todos),
	};
}

/**
 * Read a single value from a PRIME file.
 * Returns undefined if file missing or key not found.
 */
function readPrimeValue(
	filePath: string,
	key: string,
): boolean | null | undefined {
	if (!existsSync(filePath)) {
		return undefined;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const stripped = content.replace(/<!--[\s\S]*?-->/g, "");
		const match = stripped.match(new RegExp(`${key}:\\s*(true|false)`, "i"));
		if (match) {
			return match[1].toLowerCase() === "true";
		}
	} catch (err) {
		// File exists but couldn't be read - warn user
		console.warn(
			`Warning: Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return undefined;
}

/**
 * Read a setting from PRIME.md with local override support.
 * Priority: PRIME.local.md > PRIME.md > default
 */
function getPrimeSetting(
	key: string,
	defaultValue: boolean | null,
): boolean | null {
	// Try local first (overrides)
	const localValue = readPrimeValue(PATHS.PRIME_LOCAL_FILE, key);
	if (localValue !== undefined) {
		return localValue;
	}

	// Fall through to shared
	const sharedValue = readPrimeValue(PATHS.PRIME_FILE, key);
	if (sharedValue !== undefined) {
		return sharedValue;
	}

	return defaultValue;
}

/**
 * Get confirm-mode setting from PRIME.md with local override support.
 *
 * Priority (handled at call site):
 * 1. --confirm/--no-confirm flags (per-command)
 * 2. PRIME.local.md confirm-mode (local override)
 * 3. PRIME.md confirm-mode (shared default)
 * 4. Default: false (no confirmations)
 */
export function getConfirmMode(): boolean {
	return getPrimeSetting("confirm-mode", false) ?? false;
}

/**
 * Get require-summary setting from PRIME.md with local override support.
 *
 * Returns: true | false | null (null = not configured, agent should decide or ask)
 */
export function getRequireSummary(): boolean | null {
	return getPrimeSetting("require-summary", null);
}
