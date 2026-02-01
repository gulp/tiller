/**
 * tiller accept command - Accept ahoy spec into tiller plans
 *
 * Usage: tiller accept <spec-ref> --as-initiative <name> [--phases <n>]
 *
 * This is the demand→supply crossing point:
 * - ahoy creates specs (demand-side)
 * - tiller accept consumes them (supply-side)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../state/config.js";
import { createRun } from "../state/run.js";
import { outputTOON } from "../types/toon.js";

interface SpecMetadata {
	id: string;
	name: string;
	path: string;
	proposal?: string;
	scope?: string;
	research?: string;
}

/**
 * Find spec folder by ref (e.g., "0001-ahoy-cli" or just "0001")
 */
function findSpec(specRef: string): SpecMetadata | null {
	const specsDir = "specs";
	if (!existsSync(specsDir)) {
		return null;
	}

	const dirs = readdirSync(specsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

	// Try exact match first
	let match = dirs.find((d) => d === specRef);

	// Try prefix match (e.g., "0001" matches "0001-ahoy-cli")
	if (!match) {
		match = dirs.find((d) => d.startsWith(`${specRef}-`) || d.startsWith(specRef));
	}

	if (!match) {
		return null;
	}

	const specPath = join(specsDir, match);
	const idMatch = match.match(/^(\d+)/);
	const id = idMatch ? idMatch[1] : match;
	const name = match.replace(/^\d+-/, "");

	const metadata: SpecMetadata = {
		id,
		name,
		path: specPath,
	};

	// Read available files
	const proposalPath = join(specPath, "PROPOSAL.md");
	if (existsSync(proposalPath)) {
		metadata.proposal = readFileSync(proposalPath, "utf-8");
	}

	const scopePath = join(specPath, "scope.md");
	if (existsSync(scopePath)) {
		metadata.scope = readFileSync(scopePath, "utf-8");
	}

	const researchPath = join(specPath, "research.md");
	if (existsSync(researchPath)) {
		metadata.research = readFileSync(researchPath, "utf-8");
	}

	return metadata;
}

/**
 * Generate plan template with provenance tracking
 */
function generateAcceptedPlanTemplate(opts: {
	phase: string;
	plan: number;
	title: string;
	objective: string;
	origin: string;
	acceptedAt: string;
}): string {
	const planNum = opts.plan.toString().padStart(2, "0");
	return `---
title: "${opts.title.replace(/"/g, '\\"')}"
phase: ${opts.phase}
plan: ${planNum}
type: execute
wave: 1
depends_on: []
files_modified: []
autonomous: true
origin: "${opts.origin}"
accepted_at: "${opts.acceptedAt}"
---

<objective>
${opts.objective}
</objective>

<!-- EXPAND: Run \`tiller plan expand ${opts.phase}-${planNum}\` to fill these sections -->
<context>
Background and constraints.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Description</name>
  <files>files/to/modify</files>
  <action>
What to do.
  </action>
</task>

</tasks>

<verification>
- [ ] \`tsc --noEmit\` passes
</verification>
<!-- END EXPAND -->
`;
}

/**
 * Extract summary/objective from PROPOSAL.md
 */
function extractProposalObjective(proposal: string): string {
	// Try to find Summary section
	const summaryMatch = proposal.match(/##\s*Summary\s*\n+([\s\S]*?)(?=\n##|\n$|$)/i);
	if (summaryMatch) {
		return summaryMatch[1].trim().split("\n")[0]; // First line of summary
	}

	// Fallback to first heading content
	const headingMatch = proposal.match(/^#\s+(.+)/m);
	if (headingMatch) {
		return headingMatch[1].trim();
	}

	return "Implement accepted proposal";
}

export function registerAcceptCommand(program: Command): void {
	program
		.command("accept <spec-ref>")
		.description("Accept ahoy spec into tiller plans (demand→supply crossing)")
		.requiredOption("--as-initiative <name>", "Initiative name to create")
		.option("--phases <n>", "Number of phases to create (default: 1)", "1")
		.option("--dry-run", "Show what would be created without writing")
		.addHelpText("after", `
Example:
  tiller accept 0001-ahoy-cli --as-initiative ahoy --phases 3

This reads specs/0001-ahoy-cli/ and creates:
  plans/ahoy/01-phase/01-01-PLAN.md
  plans/ahoy/02-phase/02-01-PLAN.md
  plans/ahoy/03-phase/03-01-PLAN.md
`)
		.action((specRef: string, options: { asInitiative: string; phases: string; dryRun?: boolean }) => {
			const spec = findSpec(specRef);
			if (!spec) {
				console.error(`Spec not found: ${specRef}`);
				console.error("Available specs:");
				const specsDir = "specs";
				if (existsSync(specsDir)) {
					const dirs = readdirSync(specsDir, { withFileTypes: true })
						.filter((d) => d.isDirectory())
						.map((d) => `  ${d.name}`);
					console.error(dirs.join("\n") || "  (none)");
				} else {
					console.error("  specs/ directory not found");
				}
				process.exit(1);
			}

			const config = loadConfig();
			const initiative = options.asInitiative;
			const numPhases = parseInt(options.phases, 10);

			if (isNaN(numPhases) || numPhases < 1) {
				console.error(`Invalid phases: ${options.phases}. Must be >= 1.`);
				process.exit(1);
			}

			const initiativeDir = join(config.paths.plans, initiative);
			const acceptedAt = new Date().toISOString();
			const origin = `spec:${spec.id}-${spec.name}`;

			// Extract objective from proposal
			const objective = spec.proposal
				? extractProposalObjective(spec.proposal)
				: `Implement ${spec.name}`;

			// Check for collisions (fail gracefully)
			if (existsSync(initiativeDir)) {
				console.error(`Initiative already exists: ${initiativeDir}`);
				console.error(`\nTo add plans to an existing initiative, use:`);
				console.error(`  tiller plan create "<objective>" --initiative ${initiative} --phase <id>`);
				console.error(`\nTo force overwrite, delete the initiative first:`);
				console.error(`  rm -rf ${initiativeDir}`);
				process.exit(1);
			}

			if (options.dryRun) {
				console.log("## Accept Plan\n");
				console.log(`Spec: ${spec.path}`);
				console.log(`Initiative: ${initiative}`);
				console.log(`Phases: ${numPhases}`);
				console.log(`Origin: ${origin}`);
				console.log(`\nWill create:`);
				console.log(`  Initiative directory: ${initiativeDir}`);
				for (let i = 1; i <= numPhases; i++) {
					const phaseId = i.toString().padStart(2, "0");
					const phaseDir = `${phaseId}-phase`;
					const planRef = `${phaseId}-01`;
					console.log(`  Phase ${phaseId}: ${join(initiativeDir, phaseDir)}`);
					console.log(`    Plan: ${planRef}-PLAN.md`);
				}
				return;
			}

			// Create initiative directory
			mkdirSync(initiativeDir, { recursive: true });
			console.log(`✓ Created initiative: ${initiativeDir}`);

			const createdPlans: Array<{ ref: string; path: string; runId: string }> = [];

			// Create phases and initial plans
			for (let i = 1; i <= numPhases; i++) {
				const phaseId = i.toString().padStart(2, "0");
				const phaseDir = `${phaseId}-phase`;
				const phasePath = join(initiativeDir, phaseDir);

				if (!existsSync(phasePath)) {
					mkdirSync(phasePath, { recursive: true });
					console.log(`✓ Created phase: ${phaseDir}`);
				}

				const planRef = `${phaseId}-01`;
				const planPath = join(phasePath, `${planRef}-PLAN.md`);

				// Generate plan with provenance
				const phaseObjective = numPhases > 1
					? `Phase ${i}: ${objective}`
					: objective;

				const template = generateAcceptedPlanTemplate({
					phase: phaseId,
					plan: 1,
					title: `Phase ${i}: ${spec.name}`,
					objective: phaseObjective,
					origin,
					acceptedAt,
				});

				writeFileSync(planPath, template);
				console.log(`✓ Created plan: ${planRef}`);

				// Create run for the plan
				const run = createRun(planPath, phaseObjective, "ready");

				createdPlans.push({ ref: planRef, path: planPath, runId: run.id });
			}

			// Output TOON summary
			outputTOON({
				accept: {
					spec: spec.path,
					initiative,
					origin,
					accepted_at: acceptedAt,
					phases_created: numPhases,
					plans: createdPlans.map((p) => ({
						ref: p.ref,
						run_id: p.runId,
						state: "ready",
					})),
				},
			}, {
				agent_hint: `Accepted spec ${spec.id} as initiative '${initiative}' with ${numPhases} phase(s). Plans are ready. Next: tiller activate ${createdPlans[0]?.ref} to start work.`,
			});
		});
}
