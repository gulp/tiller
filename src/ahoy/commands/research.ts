/**
 * Research command - Conduct research for a draft
 *
 * CLI role: Output TOON state (deterministic)
 * Agent role: Execute research workflow (inference)
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { outputTOON } from "../../tiller/types/toon.js";
import {
	classifyState,
	exitDraftNotFound,
	exitFsError,
	exitValidationError,
	findDraft,
	getDraftName,
	safeReadDir,
	safeReadFile,
	validateContent,
	validateDraftName,
} from "../utils/drafts.js";

const RESEARCH_TEMPLATE = `# {{NAME}} - Research

<topic>
## Topic

What aspect is being researched?
</topic>

<findings>
## Findings

Key discoveries and insights.
</findings>

<prior_art>
## Prior Art

Existing solutions, patterns, or prior work.
</prior_art>

<recommendations>
## Recommendations

What to do based on findings.
</recommendations>

<open_questions>
## Open Questions

What still needs investigation.
</open_questions>
`;

interface DraftState {
	name: string;
	path: string;
	files: string[];
	hasResearch: boolean;
	researchContent?: string;
	hasScope: boolean;
}

const RESEARCH_SECTIONS = [
	"topic",
	"findings",
	"prior_art",
	"recommendations",
	"open_questions",
] as const;

type SectionState = "exists" | "empty" | "missing";

/**
 * Extract section content from template for comparison
 */
function getTemplateSection(section: string): string {
	const regex = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`, "i");
	const match = RESEARCH_TEMPLATE.match(regex);
	return match ? match[1].replace(/^## .+\n+/m, "").trim() : "";
}

/**
 * Detect section states in research.md content
 */
function detectSections(
	content: string,
): Record<(typeof RESEARCH_SECTIONS)[number], SectionState> {
	const result = {} as Record<(typeof RESEARCH_SECTIONS)[number], SectionState>;

	for (const section of RESEARCH_SECTIONS) {
		const regex = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`, "i");
		const match = content.match(regex);
		if (!match) {
			result[section] = "missing";
		} else {
			const inner = match[1].replace(/^## .+\n+/m, "").trim();
			const templateContent = getTemplateSection(section);
			result[section] = inner && inner !== templateContent ? "exists" : "empty";
		}
	}
	return result;
}

/**
 * Summarize section states for agent_hint
 */
function summarizeSections(
	sections: Record<string, SectionState>,
): string {
	const empty = Object.entries(sections)
		.filter(([, v]) => v === "empty")
		.map(([k]) => k);
	const missing = Object.entries(sections)
		.filter(([, v]) => v === "missing")
		.map(([k]) => k);

	if (empty.length === 0 && missing.length === 0) {
		return "All sections filled. Review with user.";
	}
	if (missing.length > 0) {
		return `Missing sections: ${missing.join(", ")}. Malformed research.md.`;
	}
	return `Empty sections: ${empty.join(", ")}. Fill via Edit tool.`;
}

/**
 * Gather draft state for TOON output
 */
function gatherDraftState(draftPath: string): DraftState {
	const name = getDraftName(draftPath);
	const files = safeReadDir(draftPath);
	const researchPath = join(draftPath, "research.md");
	const scopePath = join(draftPath, "scope.md");
	const hasResearch = existsSync(researchPath);
	const hasScope = existsSync(scopePath);
	const researchContent = hasResearch ? safeReadFile(researchPath) : undefined;

	return {
		name,
		path: draftPath,
		files,
		hasResearch,
		hasScope,
		...(researchContent && { researchContent }),
	};
}


export function registerResearchCommand(program: Command): void {
	program
		.command("research <draft> [topic]")
		.description("Output TOON state + research workflow instructions")
		.option("--json", "Output as JSON")
		.option("--pretty", "Human-readable output")
		.option("--check", "Verify section structure without content")
		.option("--write", "Write research.md (reads from stdin)")
		.action(
			(
				draft: string,
				topic: string | undefined,
				options: {
					json?: boolean;
					pretty?: boolean;
					check?: boolean;
					write?: boolean;
				},
			) => {
				const jsonMode = options.json ?? false;

				// Validate draft name
				const validation = validateDraftName(draft);
				if (!validation.valid) {
					exitValidationError(validation.error!, jsonMode);
				}

				const cwd = process.cwd();
				let draftPath: string | null;

				try {
					draftPath = findDraft(draft, cwd);
				} catch (error) {
					exitValidationError((error as Error).message, jsonMode);
				}

				if (!draftPath) {
					exitDraftNotFound(draft, jsonMode);
				}

				const state = gatherDraftState(draftPath);

				// Check mode: verify section structure without content
				if (options.check) {
					const researchPath = join(draftPath, "research.md");
					const sections = state.hasResearch
						? detectSections(state.researchContent!)
						: {
								topic: "missing" as const,
								findings: "missing" as const,
								prior_art: "missing" as const,
								recommendations: "missing" as const,
								open_questions: "missing" as const,
							};

					const checkData = {
						draft: state.name,
						research: state.hasResearch ? researchPath : null,
						sections,
					};

					if (options.json) {
						console.log(JSON.stringify(checkData, null, 2));
						return;
					}

					outputTOON(
						{ research: checkData },
						{ agent_hint: summarizeSections(sections) },
					);
					return;
				}

				// Write mode: read from stdin and write research.md
				if (options.write) {
					let content = "";
					const stdin = process.stdin;
					stdin.setEncoding("utf8");

					if (stdin.isTTY) {
						exitValidationError(
							"--write requires content via stdin. Usage: echo 'content' | ahoy research <draft> --write",
							jsonMode,
						);
					}

					stdin.on("error", (error) => {
						exitValidationError(
							`Error reading stdin: ${error.message}`,
							jsonMode,
						);
					});

					stdin.on("data", (chunk) => {
						content += chunk;
					});

					stdin.on("end", () => {
						// Validate content before writing
						const contentValidation = validateContent(content, "research.md");
						if (!contentValidation.valid) {
							exitValidationError(contentValidation.error!, jsonMode);
						}

						const researchPath = join(draftPath, "research.md");
						try {
							writeFileSync(researchPath, content);
							if (jsonMode) {
								console.log(
									JSON.stringify(
										{
											written: researchPath,
											size: content.length,
										},
										null,
										2,
									),
								);
							} else {
								console.log(`Written: ${researchPath}`);
							}
						} catch (error) {
							exitFsError(
								"write research.md",
								researchPath,
								error as NodeJS.ErrnoException,
								jsonMode,
							);
						}
					});

					return;
				}

				// Build state data
				const researchPath = join(draftPath, "research.md");

				// Create research.md from template if missing
				let createdTemplate = false;
				if (!state.hasResearch) {
					const content = RESEARCH_TEMPLATE.replace(
						/\{\{NAME\}\}/g,
						state.name,
					);
					try {
						writeFileSync(researchPath, content);
						state.hasResearch = true;
						createdTemplate = true;
					} catch (error) {
						exitFsError(
							"create research.md",
							researchPath,
							error as NodeJS.ErrnoException,
							jsonMode,
						);
					}
				}

				const researchData = {
					draft: state.name,
					state: classifyState(state.name),
					topic: topic ?? null,
					research: {
						exists: state.hasResearch,
						path: researchPath,
						created: createdTemplate,
						...(state.researchContent && { content: state.researchContent }),
					},
					scope: {
						exists: state.hasScope,
					},
					files: state.files,
				};

				// JSON output
				if (options.json) {
					console.log(JSON.stringify(researchData, null, 2));
					return;
				}

				// Pretty output
				const printPretty = () => {
					console.log(`Draft: ${state.name}`);
					console.log(`State: ${classifyState(state.name)}`);
					console.log(`Topic: ${topic ?? "(none)"}`);
					console.log(`Research: ${state.hasResearch ? "exists" : "missing"}`);
					console.log(`Scope: ${state.hasScope ? "exists" : "missing"}`);
					if (state.hasResearch && state.researchContent) {
						console.log(`\n--- research.md ---\n${state.researchContent}`);
					}
				};

				if (options.pretty) {
					printPretty();
					return;
				}

				// Default: TOON with agent_hint
				const hint = createdTemplate
					? topic
						? `Template created at ${researchPath}. Research ${topic} using WebSearch/Grep. Fill in the sections via Edit tool.`
						: `Template created at ${researchPath}. Use AskUserQuestion: "What aspect of ${state.name} should I research?" Then fill in sections.`
					: `Research exists. Review ${researchPath} with user. Update via Edit tool if needed.`;

				outputTOON(
					{ research: researchData },
					{
						agent_hint: hint,
						prettyFn: printPretty,
					},
				);
			},
		);
}
