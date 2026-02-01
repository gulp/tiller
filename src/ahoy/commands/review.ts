/**
 * Review command - Output TOON state + pre-handoff review instructions
 *
 * Agent-first pattern: CLI outputs structured data + instructions,
 * agent executes the instructions to review draft before handoff.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
	type BaseDraftState,
	classifyState,
	exitDraftNotFound,
	exitValidationError,
	findDraft,
	getDraftName,
	safeReadDir,
	safeReadFile,
	validateDraftName,
} from "../utils/drafts.js";

interface DraftState extends BaseDraftState {
	hasScope: boolean;
	hasResearch: boolean;
	hasProposal: boolean;
	scopeSummary?: string;
}

/**
 * Extract first paragraph from markdown as summary
 */
function extractSummary(content: string): string {
	const lines = content.split("\n");
	let inContent = false;
	const summaryLines: string[] = [];

	for (const line of lines) {
		if (line.startsWith("#")) {
			inContent = true;
			continue;
		}
		if (inContent && line.trim() === "" && summaryLines.length > 0) {
			break;
		}
		if (inContent && line.trim()) {
			summaryLines.push(line.trim());
		}
	}

	return summaryLines.join(" ").slice(0, 200);
}

/**
 * Gather draft state for TOON output
 */
function gatherDraftState(draftPath: string): DraftState {
	const name = getDraftName(draftPath);
	const files = safeReadDir(draftPath);
	const scopePath = join(draftPath, "scope.md");
	const researchPath = join(draftPath, "research.md");
	const proposalPath = join(draftPath, "PROPOSAL.md");

	const hasScope = existsSync(scopePath);
	const hasResearch = existsSync(researchPath);
	const hasProposal = existsSync(proposalPath);

	let scopeSummary: string | undefined;
	if (hasScope) {
		const scopeContent = safeReadFile(scopePath);
		if (scopeContent) {
			scopeSummary = extractSummary(scopeContent);
		}
	}

	return {
		name,
		path: draftPath,
		state: classifyState(name),
		files,
		hasScope,
		hasResearch,
		hasProposal,
		...(scopeSummary && { scopeSummary }),
	};
}

/**
 * Generate agent instructions for pre-handoff review
 */
function generateInstructions(state: DraftState): string {
	const draftName = state.name.replace(/\.lock$/, "").replace(/^\d{4}-/, "");

	const checklist: string[] = [];

	// Build checklist based on state
	if (!state.hasScope) {
		checklist.push(
			`- [ ] **scope.md missing** — Run \`ahoy discuss ${state.name}\` first`,
		);
	} else {
		checklist.push("- [x] scope.md exists");
	}

	if (!state.hasResearch) {
		checklist.push("- [ ] research.md missing (optional but recommended)");
	} else {
		checklist.push("- [x] research.md exists");
	}

	if (state.state === "drafting") {
		checklist.push(
			`- [ ] **Not numbered** — Run \`ahoy number ${state.name}\``,
		);
	} else {
		checklist.push(`- [x] Numbered: ${state.name}`);
	}

	if (state.state === "locked") {
		checklist.push("- [x] Already locked (ready for handoff)");
	} else {
		checklist.push(
			`- [ ] Not locked — Run \`ahoy lock ${state.name}\` when ready`,
		);
	}

	const readyForHandoff = state.hasScope && state.state === "locked";

	return `Review "${draftName}" before handoff.

## Pre-Handoff Checklist

${checklist.join("\n")}

## Review Flow

1. **Check completeness** (use AskUserQuestion):
   - header: "Review"
   - question: "Does the scope cover everything needed?"
   - options:
     - "Yes, looks complete"
     - "Missing something" — What's missing?
     - "Let me check the files"

2. **Verify research** (if exists):
   Read research.md and confirm findings are incorporated in scope.

3. **Decision gate** (use AskUserQuestion):
   - header: "Handoff?"
   - question: "${readyForHandoff ? "Ready to hand off to tiller?" : "Draft needs work before handoff:"}"
   - options:
     ${
				readyForHandoff
					? `- "Yes, hand off" — Run handoff command
     - "Not yet" — Continue refining`
					: `- "Fix issues first" — Address checklist items
     - "Hand off anyway" — Use --force flag`
			}

## Next Steps

${
	readyForHandoff
		? `Draft is ready! Run:
\`\`\`
ahoy handoff <initiative> <phase>
\`\`\``
		: `Address checklist items above, then run:
\`\`\`
ahoy review ${state.name}
\`\`\``
}`;
}

export function registerReviewCommand(program: Command): void {
	program
		.command("review <draft>")
		.description("Output TOON state + pre-handoff review instructions")
		.option("--json", "Output as JSON instead of TOON")
		.action((draft: string, options: { json?: boolean }) => {
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
			const instructions = generateInstructions(state);

			if (options.json) {
				console.log(
					JSON.stringify(
						{
							draft: state,
							ready_for_handoff: state.hasScope && state.state === "locked",
							agent_instructions: instructions,
						},
						null,
						2,
					),
				);
				return;
			}

			// TOON output
			console.log("```toon");
			console.log("review:");
			console.log(`  draft: ${state.name}`);
			console.log(`  state: ${state.state}`);
			console.log(
				`  ready_for_handoff: ${state.hasScope && state.state === "locked"}`,
			);
			console.log(`  has_scope: ${state.hasScope}`);
			console.log(`  has_research: ${state.hasResearch}`);
			console.log(`  has_proposal: ${state.hasProposal}`);
			console.log(`  files[${state.files.length}]:`);
			for (const f of state.files) {
				console.log(`    - ${f}`);
			}
			console.log("```");
			console.log("");
			console.log("## Agent Instructions");
			console.log("");
			console.log(instructions);
		});
}
