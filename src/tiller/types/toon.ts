/**
 * TOON (Token-Optimized Object Notation) types for agent-human handoff
 *
 * These structures are returned by CLI commands when --confirm or --human
 * flags are used, allowing agents to present structured choices via AskUserQuestion.
 */

import { DELIMITERS, encode } from "@toon-format/toon";

// ============================================
// TOON Envelope - wraps output with agent instructions
// ============================================

type TOONTask = "confirmation" | "uat_checklist";

/** Encode options for TOON output */
const TOON_OPTS = {
	indent: 2,
	delimiter: DELIMITERS.tab,
	keyFolding: "safe" as const,
};

function wrapTOON(data: unknown, task: TOONTask): string {
	const taskInstructions: Record<TOONTask, string> = {
		confirmation:
			"Use AskUserQuestion to present options (single question, multiSelect: false)",
		uat_checklist:
			"Use AskUserQuestion with multiSelect: true listing all tests as options. Ask 'Which checks passed?' Then use final options based on result.",
	};

	return `Data is in TOON format (2-space indent YAML).
\`\`\`toon
${encode(data, TOON_OPTS)}
\`\`\`
Task: ${taskInstructions[task]}`;
}

// ============================================
// Confirmation TOON (for --confirm flag)
// ============================================

export interface ConfirmationOption {
	label: string;
	action: string | null; // CLI command to run, or null for cancel
	description?: string;
}

export interface ConfirmationTOON {
	confirmation: {
		action: string; // e.g., "approve", "complete", "abandon"
		run: string; // plan ref (run identifier in Phase 1)
		intent: string; // run intent for context
		question: string; // human-readable question
		options: ConfirmationOption[];
		risk_level?: "low" | "medium" | "high";
	};
}

// Risk levels for default confirm behavior
export const ACTION_RISK: Record<string, "low" | "medium" | "high"> = {
	approve: "low",
	import: "low",
	activate: "low",
	pause: "low",
	resume: "low",
	complete: "medium",
	abandon: "high",
	rework: "medium",
};

export function formatConfirmationTOON(conf: ConfirmationTOON): string {
	return wrapTOON(conf, "confirmation");
}

// ============================================
// UAT Checklist TOON (for --human flag on verify)
// ============================================

export interface UATTest {
	name: string;
	description: string;
	steps: string[];
	expected: string;
}

export interface UATChecklistTOON {
	uat_checklist: {
		run: string; // plan ref (run identifier in Phase 1)
		plan_path: string;
		intent: string;
		tests: UATTest[];
		options: ConfirmationOption[];
	};
}

export function formatUATChecklistTOON(checklist: UATChecklistTOON): string {
	return wrapTOON(checklist, "uat_checklist");
}

// ============================================
// Helper to create standard confirmation
// ============================================

export function createConfirmation(
	action: string,
	run: string,
	intent: string,
	question: string,
): ConfirmationTOON {
	const risk = ACTION_RISK[action] ?? "low";

	return {
		confirmation: {
			action,
			run,
			intent,
			question,
			risk_level: risk,
			options: [
				{
					label: `Yes, ${action}`,
					action: `tiller ${action} ${run}`,
				},
				{
					label: "No, cancel",
					action: null,
				},
			],
		},
	};
}

// ============================================
// Generic TOON output (for TOON-first CLI)
// ============================================

export interface OutputOptions {
	pretty?: boolean;
	prettyFn?: () => void; // Custom pretty-print function
	agent_hint?: string; // Presentation guidance for agents
}

/**
 * Output data as TOON (default) or pretty-printed (--pretty flag).
 *
 * TOON-first design: agents receive structured YAML they can parse,
 * humans can use --pretty for readable output.
 */
export function outputTOON(data: unknown, options?: OutputOptions): void {
	if (options?.pretty) {
		if (options.prettyFn) {
			options.prettyFn();
		} else {
			// Default pretty: JSON with indent
			console.log(JSON.stringify(data, null, 2));
		}
	} else {
		// TOON format: YAML in code block, agent_hint outside fence (meta-instruction)
		console.log("```toon");
		console.log(encode(data, TOON_OPTS));
		console.log("```");
		if (options?.agent_hint) {
			console.log(`agent_hint: "${options.agent_hint.replace(/"/g, '\\"')}"`);
		}
	}
}

// ============================================
// Checkpoint TOON (for GSD-style inline checkpoints)
// ============================================

export interface CheckpointTOON {
	checkpoint: {
		type: "human-verify" | "decision" | "human-action";
		gate: "blocking" | "informational";
		what_built: string;
		how_to_verify: string[];
		resume_signal: string;
	};
}

export interface CheckpointsTOON {
	checkpoints: {
		plan: string;
		plan_path: string;
		items: CheckpointTOON["checkpoint"][];
		options: ConfirmationOption[];
	};
}

/**
 * Convert checkpoint task to TOON format
 */
export function checkpointTaskToTOON(task: {
	type: "human-verify" | "decision" | "human-action";
	gate: "blocking" | "informational";
	whatBuilt: string;
	howToVerify: string;
	resumeSignal: string;
}): CheckpointTOON["checkpoint"] {
	// Split how_to_verify into steps if it contains newlines or numbered items
	const howToVerify = task.howToVerify
		.split(/\n|(?:\d+\.\s+)/)
		.map((s) => s.trim())
		.filter(Boolean);

	return {
		type: task.type,
		gate: task.gate,
		what_built: task.whatBuilt,
		how_to_verify:
			howToVerify.length > 0
				? howToVerify
				: [task.howToVerify || "Verify the implementation"],
		resume_signal: task.resumeSignal,
	};
}

/**
 * Format checkpoint tasks as TOON for agent presentation
 */
export function formatCheckpointsTOON(
	planRef: string,
	planPath: string,
	tasks: Array<{
		type: "human-verify" | "decision" | "human-action";
		gate: "blocking" | "informational";
		whatBuilt: string;
		howToVerify: string;
		resumeSignal: string;
	}>,
): string {
	const items = tasks.map(checkpointTaskToTOON);

	const data: CheckpointsTOON = {
		checkpoints: {
			plan: planRef,
			plan_path: planPath,
			items,
			options: [
				{ label: "All passed", action: `tiller verify ${planRef} --pass` },
				{
					label: "Issues found",
					action: `tiller verify ${planRef} --fail --issue "..."`,
				},
				{ label: "Skip for now", action: null },
			],
		},
	};

	return wrapTOON(data, "uat_checklist");
}

// ============================================
// Error output with agent hints
// ============================================

export interface ErrorOptions {
	/** Guidance for agents on how to recover from this error */
	agent_hint?: string;
	/** Suggested commands to try */
	suggestions?: string[];
	/** Exit code (default: 1) */
	exitCode?: number;
}

/**
 * Output error message with optional agent_hint for self-recovery.
 *
 * Agent-first design: Errors include structured hints that agents can parse
 * to determine next steps without human intervention.
 *
 * @param message - Human-readable error message
 * @param options - Agent hint and suggestions
 */
export function outputError(message: string, options?: ErrorOptions): never {
	console.error(message);

	if (options?.suggestions?.length) {
		console.error("\nSuggestions:");
		for (const suggestion of options.suggestions) {
			console.error(`  ${suggestion}`);
		}
	}

	if (options?.agent_hint) {
		// Output on stderr but in parseable format
		console.error(`agent_hint: "${options.agent_hint.replace(/"/g, '\\"')}"`);
	}

	process.exit(options?.exitCode ?? 1);
}
