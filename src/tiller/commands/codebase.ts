/**
 * Codebase analysis commands
 *
 * - tiller codebase map: Analyze codebase with parallel Explore agents
 *
 * Outputs TOON with agent configurations for spawning parallel exploration.
 * The actual agent spawning happens via Claude Code Task tool in the skill.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { outputTOON } from "../types/toon.js";

// Codebase document types that will be generated
const CODEBASE_DOCS = [
	"STACK.md",
	"ARCHITECTURE.md",
	"STRUCTURE.md",
	"CONVENTIONS.md",
	"TESTING.md",
	"INTEGRATIONS.md",
	"CONCERNS.md",
] as const;

type CodebaseDoc = (typeof CODEBASE_DOCS)[number];

// Agent configurations for parallel exploration
interface AgentConfig {
	id: number;
	name: string;
	focus: string[];
	outputs: CodebaseDoc[];
	prompt: string;
}

const AGENT_CONFIGS: AgentConfig[] = [
	{
		id: 1,
		name: "Stack + Integrations",
		focus: ["technology", "dependencies", "external services"],
		outputs: ["STACK.md", "INTEGRATIONS.md"],
		prompt: `Analyze this codebase for technology stack and integrations.

Focus on:
1. **Languages & Frameworks**: Primary languages, major frameworks, runtime versions
2. **Dependencies**: Key dependencies from package.json/Cargo.toml/go.mod/etc.
3. **External Services**: APIs, databases, message queues, cloud services
4. **Build Tools**: Bundlers, compilers, task runners

Output format for STACK.md:
## Languages
- List with versions

## Frameworks
- List with purposes

## Key Dependencies
- List with what they're used for

## Build & Tooling
- Build system details

Output format for INTEGRATIONS.md:
## External APIs
- List endpoints and purposes

## Databases
- List with connection patterns

## Cloud Services
- List AWS/GCP/Azure services used

## Third-Party Services
- List external integrations`,
	},
	{
		id: 2,
		name: "Architecture + Structure",
		focus: ["system design", "directory layout", "module organization"],
		outputs: ["ARCHITECTURE.md", "STRUCTURE.md"],
		prompt: `Analyze this codebase for architecture and structure.

Focus on:
1. **Architecture Pattern**: Monolith, microservices, serverless, etc.
2. **Layers**: Presentation, business logic, data access layers
3. **Data Flow**: How data moves through the system
4. **Directory Layout**: How code is organized
5. **Module Boundaries**: How modules/packages are separated

Output format for ARCHITECTURE.md:
## Overview
- High-level architecture description

## Patterns
- Design patterns used (MVC, CQRS, etc.)

## Layers
- System layers and responsibilities

## Data Flow
- How data moves through the system

Output format for STRUCTURE.md:
## Directory Layout
\`\`\`
src/
├── components/
├── services/
...
\`\`\`

## Key Directories
- Purpose of each major directory

## Module Boundaries
- How code is organized into modules

## Entry Points
- Main entry files and their purposes`,
	},
	{
		id: 3,
		name: "Conventions + Testing",
		focus: ["code style", "naming patterns", "test structure"],
		outputs: ["CONVENTIONS.md", "TESTING.md"],
		prompt: `Analyze this codebase for conventions and testing practices.

Focus on:
1. **Code Style**: Formatting, linting rules, style guides
2. **Naming Conventions**: Files, functions, variables, types
3. **Patterns**: Common patterns used throughout
4. **Test Framework**: Testing libraries and setup
5. **Test Structure**: How tests are organized
6. **Coverage**: Test coverage patterns

Output format for CONVENTIONS.md:
## Code Style
- Formatting and linting rules

## Naming Conventions
- File naming patterns
- Function/method naming
- Variable naming
- Type/interface naming

## Common Patterns
- Recurring patterns in the codebase

## Documentation
- Comment and doc conventions

Output format for TESTING.md:
## Test Framework
- Testing libraries used

## Test Structure
\`\`\`
tests/
├── unit/
├── integration/
...
\`\`\`

## Test Patterns
- Common testing patterns

## Coverage
- Coverage tools and targets

## Running Tests
- Commands to run tests`,
	},
	{
		id: 4,
		name: "Concerns",
		focus: ["technical debt", "risks", "issues"],
		outputs: ["CONCERNS.md"],
		prompt: `Analyze this codebase for technical concerns and issues.

Focus on:
1. **Technical Debt**: Areas that need refactoring
2. **Security Concerns**: Potential vulnerabilities
3. **Performance Issues**: Potential bottlenecks
4. **Maintenance Issues**: Hard-to-maintain code
5. **Missing Tests**: Areas lacking test coverage
6. **Documentation Gaps**: Undocumented areas

Output format for CONCERNS.md:
## Technical Debt
- Areas needing refactoring
- Outdated patterns or dependencies

## Security Concerns
- Potential vulnerabilities (no specifics, just categories)
- Missing security measures

## Performance
- Potential bottlenecks
- Optimization opportunities

## Maintenance
- Complex areas that are hard to maintain
- Tightly coupled components

## Test Coverage Gaps
- Areas lacking tests

## Documentation Gaps
- Undocumented critical areas

## Recommendations
- Prioritized list of improvements`,
	},
];

interface CodebaseMapTOON {
	codebase_map: {
		output_dir: string;
		documents: CodebaseDoc[];
		agents: Array<{
			id: number;
			name: string;
			focus: string[];
			outputs: CodebaseDoc[];
			prompt: string;
		}>;
		focus_area: string | null;
		existing_docs: CodebaseDoc[];
		action: "create" | "refresh" | "skip";
	};
}

function getExistingDocs(codebaseDir: string): CodebaseDoc[] {
	if (!existsSync(codebaseDir)) {
		return [];
	}

	const files = readdirSync(codebaseDir);
	return CODEBASE_DOCS.filter((doc) => files.includes(doc));
}

function isMinimalCodebase(rootDir: string = "."): boolean {
	// Check if this is a trivial codebase (<5 meaningful files)
	try {
		let fileCount = 0;
		const srcDir = join(rootDir, "src");
		const libDir = join(rootDir, "lib");

		const countFiles = (dir: string) => {
			if (!existsSync(dir)) return;
			const entries = readdirSync(dir);
			for (const entry of entries) {
				const path = join(dir, entry);
				try {
					const stat = statSync(path);
					if (stat.isDirectory()) {
						countFiles(path);
					} else if (stat.isFile()) {
						// Count code files only
						if (/\.(ts|js|py|go|rs|java|c|cpp|rb|php)$/.test(entry)) {
							fileCount++;
						}
					}
				} catch {
					// Skip inaccessible files
				}
			}
		};

		if (existsSync(srcDir)) countFiles(srcDir);
		if (existsSync(libDir)) countFiles(libDir);
		if (fileCount === 0) countFiles(rootDir);

		return fileCount < 5;
	} catch {
		return false;
	}
}

function customizePromptsForFocus(
	agents: AgentConfig[],
	focus: string | null,
): AgentConfig[] {
	if (!focus) return agents;

	return agents.map((agent) => ({
		...agent,
		prompt: `${agent.prompt}\n\n**FOCUS AREA: ${focus}**\nPrioritize analysis of the "${focus}" subsystem/area. Still cover general aspects but emphasize findings related to ${focus}.`,
	}));
}

export function registerCodebaseCommands(program: Command): void {
	const codebase = program
		.command("codebase")
		.description("Codebase analysis commands");

	codebase
		.command("map")
		.description("Analyze codebase with parallel Explore agents")
		.option("--focus <area>", "Focus analysis on specific area (e.g., 'api')")
		.option("--refresh", "Refresh existing codebase documents")
		.option("--dry-run", "Show what would be created without creating")
		.option("--json", "Output raw JSON instead of TOON")
		.option("--pretty", "Output human-readable format")
		.option("--create-dir", "Create .planning/codebase/ directory")
		.action(
			(opts: {
				focus?: string;
				refresh?: boolean;
				dryRun?: boolean;
				json?: boolean;
				pretty?: boolean;
				createDir?: boolean;
			}) => {
				const codebaseDir = join(".planning", "codebase");
				const existingDocs = getExistingDocs(codebaseDir);
				const hasExisting = existingDocs.length > 0;

				// Determine action
				let action: "create" | "refresh" | "skip";
				if (hasExisting && !opts.refresh) {
					action = "skip";
				} else if (hasExisting && opts.refresh) {
					action = "refresh";
				} else {
					action = "create";
				}

				// Check for minimal codebase
				if (action !== "skip" && isMinimalCodebase()) {
					if (opts.pretty) {
						console.log(
							"Codebase appears minimal (<5 files). Mapping may not be useful.",
						);
						console.log("Use --refresh to map anyway.");
						return;
					}
					// Include warning in TOON output
				}

				// Create directory if requested
				if (opts.createDir && !existsSync(codebaseDir)) {
					if (opts.dryRun) {
						console.log(`Would create: ${codebaseDir}`);
					} else {
						mkdirSync(codebaseDir, { recursive: true });
						console.log(`Created: ${codebaseDir}`);
					}
					return;
				}

				// Customize prompts for focus area
				const agents = customizePromptsForFocus(
					AGENT_CONFIGS,
					opts.focus ?? null,
				);

				const toonData: CodebaseMapTOON = {
					codebase_map: {
						output_dir: codebaseDir,
						documents: [...CODEBASE_DOCS],
						agents: agents.map((a) => ({
							id: a.id,
							name: a.name,
							focus: a.focus,
							outputs: a.outputs,
							prompt: a.prompt,
						})),
						focus_area: opts.focus ?? null,
						existing_docs: existingDocs,
						action,
					},
				};

				if (opts.json) {
					console.log(JSON.stringify(toonData, null, 2));
					return;
				}

				if (opts.pretty) {
					printPretty(toonData, opts.dryRun ?? false);
					return;
				}

				// Default: TOON output with agent hint
				const agentHint =
					action === "skip"
						? `Codebase documents already exist at ${codebaseDir}. Use --refresh to update them, or proceed with existing documents.`
						: `Spawn 4 parallel Explore agents using Task tool with subagent_type="Explore". Each agent analyzes different aspects. Collect results and write to ${codebaseDir}/*.md files.`;

				outputTOON(toonData, { agent_hint: agentHint });
			},
		);

	codebase
		.command("status")
		.description("Show status of codebase documents")
		.option("--json", "Output as JSON")
		.action((opts: { json?: boolean }) => {
			const codebaseDir = join(".planning", "codebase");
			const existingDocs = getExistingDocs(codebaseDir);
			const missingDocs = CODEBASE_DOCS.filter(
				(doc) => !existingDocs.includes(doc),
			);

			const status = {
				directory: codebaseDir,
				exists: existsSync(codebaseDir),
				documents: {
					existing: existingDocs,
					missing: missingDocs,
					total: CODEBASE_DOCS.length,
					complete: existingDocs.length === CODEBASE_DOCS.length,
				},
			};

			if (opts.json) {
				console.log(JSON.stringify(status, null, 2));
				return;
			}

			outputTOON(
				{ codebase_status: status },
				{
					agent_hint: status.documents.complete
						? "Codebase documentation is complete."
						: `Missing ${missingDocs.length} documents: ${missingDocs.join(", ")}. Run \`tiller codebase map\` to generate.`,
				},
			);
		});
}

function printPretty(data: CodebaseMapTOON, dryRun: boolean): void {
	const { codebase_map: cm } = data;

	console.log("Codebase Map Command");
	console.log("═".repeat(50));
	console.log("");

	if (cm.action === "skip") {
		console.log("Status: Documents already exist");
		console.log(`Location: ${cm.output_dir}`);
		console.log(`Existing: ${cm.existing_docs.join(", ")}`);
		console.log("");
		console.log("Use --refresh to update existing documents.");
		return;
	}

	console.log(`Action: ${cm.action === "refresh" ? "Refresh" : "Create"}`);
	console.log(`Output: ${cm.output_dir}`);
	if (cm.focus_area) {
		console.log(`Focus: ${cm.focus_area}`);
	}
	console.log("");

	console.log("Documents to generate:");
	for (const doc of cm.documents) {
		const exists = cm.existing_docs.includes(doc);
		const marker = exists ? "↻" : "+";
		console.log(`  ${marker} ${doc}`);
	}
	console.log("");

	console.log("Parallel agents:");
	for (const agent of cm.agents) {
		console.log(`  ${agent.id}. ${agent.name}`);
		console.log(`     Focus: ${agent.focus.join(", ")}`);
		console.log(`     Outputs: ${agent.outputs.join(", ")}`);
	}

	if (dryRun) {
		console.log("");
		console.log("(dry-run: no files created)");
	}
}
