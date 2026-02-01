/**
 * TOML Parser for Workflow Definitions
 *
 * Parses workflow definition files from TOML format and validates
 * their structure against the type schema.
 */

import * as fs from "node:fs/promises";
import * as toml from "@iarna/toml";
import type {
	ConditionOperator,
	StepEdge,
	WorkflowDefinition,
	WorkflowStep,
	WorkflowValidationError,
	WorkflowValidationResult,
} from "./types.js";

// =============================================================================
// TOML Parsing
// =============================================================================

/**
 * Raw TOML structure before transformation to typed WorkflowDefinition.
 */
interface RawTomlWorkflow {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	initial_step?: unknown;
	terminal_steps?: unknown;
	steps?: Record<string, RawTomlStep>;
}

interface RawTomlStep {
	name?: unknown;
	description?: unknown;
	outputs?: unknown;
	next?: RawTomlEdge[];
}

interface RawTomlEdge {
	target?: unknown;
	condition?: unknown;
	label?: unknown;
}

// =============================================================================
// Condition Validation
// =============================================================================

const VALID_OPERATORS: ConditionOperator[] = [
	"exists",
	"eq",
	"contains",
	"and",
	"or",
	"not",
];

/**
 * Validates a condition expression string.
 *
 * Valid formats:
 * - exists(key)
 * - eq(key, value)
 * - contains(key, value)
 * - and(cond1, cond2)
 * - or(cond1, cond2)
 * - not(cond)
 *
 * @returns true if syntax is valid, false otherwise
 */
export function validateCondition(condition: string): boolean {
	const trimmed = condition.trim();
	if (!trimmed) return false;

	// Match operator(args) pattern
	const match = trimmed.match(/^(\w+)\s*\((.*)\)$/s);
	if (!match) return false;

	const [, operator, argsStr] = match;

	// Check operator is valid
	if (!VALID_OPERATORS.includes(operator as ConditionOperator)) {
		return false;
	}

	// For recursive operators, validate nested conditions
	if (operator === "not") {
		return validateCondition(argsStr);
	}

	if (operator === "and" || operator === "or") {
		// Need to find the comma that separates the two conditions
		// This is tricky because nested conditions also have commas
		const splitPoint = findTopLevelComma(argsStr);
		if (splitPoint === -1) return false;

		const left = argsStr.slice(0, splitPoint).trim();
		const right = argsStr.slice(splitPoint + 1).trim();

		return validateCondition(left) && validateCondition(right);
	}

	// For leaf operators (exists, eq, contains), just check we have arguments
	if (operator === "exists") {
		return argsStr.trim().length > 0;
	}

	if (operator === "eq" || operator === "contains") {
		const splitPoint = findTopLevelComma(argsStr);
		return splitPoint !== -1;
	}

	return false;
}

/**
 * Find the index of the top-level comma in an arguments string.
 * Respects nested parentheses.
 */
function findTopLevelComma(str: string): number {
	let depth = 0;
	let inString = false;
	let stringChar = "";

	for (let i = 0; i < str.length; i++) {
		const char = str[i];
		const prevChar = i > 0 ? str[i - 1] : "";

		// Handle string literals
		if ((char === '"' || char === "'") && prevChar !== "\\") {
			if (!inString) {
				inString = true;
				stringChar = char;
			} else if (char === stringChar) {
				inString = false;
			}
			continue;
		}

		if (inString) continue;

		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === "," && depth === 0) {
			return i;
		}
	}

	return -1;
}

// =============================================================================
// Workflow Parsing
// =============================================================================

/**
 * Parse a TOML string into a WorkflowDefinition.
 *
 * @throws Error if TOML is invalid or required fields are missing
 */
export function parseWorkflow(tomlContent: string): WorkflowDefinition {
	let raw: RawTomlWorkflow;

	try {
		raw = toml.parse(tomlContent) as RawTomlWorkflow;
	} catch (err) {
		throw new Error(
			`Invalid TOML syntax: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Validate and transform
	const validation = validateRawWorkflow(raw);
	if (!validation.valid) {
		const errorMessages = validation.errors
			.map((e) => `${e.path ? `${e.path}: ` : ""}${e.message}`)
			.join("; ");
		throw new Error(`Invalid workflow definition: ${errorMessages}`);
	}

	return transformToWorkflowDefinition(raw);
}

/**
 * Load and parse a workflow definition from a file.
 *
 * @throws Error if file not found, cannot be read, or is invalid
 */
export async function loadWorkflowFile(
	path: string,
): Promise<WorkflowDefinition> {
	let content: string;

	try {
		content = await fs.readFile(path, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Workflow file not found: ${path}`);
		}
		throw new Error(
			`Cannot read workflow file: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return parseWorkflow(content);
}

/**
 * Validate the workflow definition structure without parsing.
 * Returns detailed validation errors.
 */
export function validateWorkflow(
	tomlContent: string,
): WorkflowValidationResult {
	let raw: RawTomlWorkflow;

	try {
		raw = toml.parse(tomlContent) as RawTomlWorkflow;
	} catch (err) {
		return {
			valid: false,
			errors: [
				{
					type: "MISSING_FIELD",
					message: `Invalid TOML syntax: ${err instanceof Error ? err.message : String(err)}`,
				},
			],
			warnings: [],
		};
	}

	return validateRawWorkflow(raw);
}

// =============================================================================
// Validation Helpers
// =============================================================================

function validateRawWorkflow(raw: RawTomlWorkflow): WorkflowValidationResult {
	const errors: WorkflowValidationError[] = [];

	// Check required top-level fields
	if (!raw.name || typeof raw.name !== "string") {
		errors.push({
			type: "MISSING_FIELD",
			message: "Missing or invalid 'name' field",
			path: "name",
		});
	}

	if (!raw.version || typeof raw.version !== "string") {
		errors.push({
			type: "MISSING_FIELD",
			message: "Missing or invalid 'version' field",
			path: "version",
		});
	}

	if (!raw.description || typeof raw.description !== "string") {
		errors.push({
			type: "MISSING_FIELD",
			message: "Missing or invalid 'description' field",
			path: "description",
		});
	}

	if (!raw.initial_step || typeof raw.initial_step !== "string") {
		errors.push({
			type: "MISSING_FIELD",
			message: "Missing or invalid 'initial_step' field",
			path: "initial_step",
		});
	}

	if (
		!raw.terminal_steps ||
		!Array.isArray(raw.terminal_steps) ||
		raw.terminal_steps.length === 0
	) {
		errors.push({
			type: "MISSING_FIELD",
			message: "Missing or empty 'terminal_steps' array",
			path: "terminal_steps",
		});
	}

	if (!raw.steps || typeof raw.steps !== "object") {
		errors.push({
			type: "MISSING_FIELD",
			message: "Missing 'steps' section",
			path: "steps",
		});
		return { valid: false, errors, warnings: [] };
	}

	// Collect all step IDs
	const stepIds = new Set(Object.keys(raw.steps));
	const seenIds = new Set<string>();

	// Validate each step
	for (const [stepId, step] of Object.entries(raw.steps)) {
		// Check for duplicate IDs (shouldn't happen with object keys but defensive)
		if (seenIds.has(stepId)) {
			errors.push({
				type: "duplicate_step",
				message: `Duplicate step ID: ${stepId}`,
				path: `steps.${stepId}`,
			});
		}
		seenIds.add(stepId);

		// Validate step name
		if (!step.name || typeof step.name !== "string") {
			errors.push({
				type: "MISSING_FIELD",
				message: `Step '${stepId}' missing required 'name' field`,
				path: `steps.${stepId}.name`,
			});
		}

		// Validate outputs (optional but must be array if present)
		if (step.outputs !== undefined && !Array.isArray(step.outputs)) {
			errors.push({
				type: "MISSING_FIELD",
				message: `Step '${stepId}' has invalid 'outputs' (must be array)`,
				path: `steps.${stepId}.outputs`,
			});
		}

		// Validate edges
		if (step.next && Array.isArray(step.next)) {
			step.next.forEach((edge, i) => {
				// Validate target exists
				if (!edge.target || typeof edge.target !== "string") {
					errors.push({
						type: "MISSING_FIELD",
						message: `Edge missing 'target' field`,
						path: `steps.${stepId}.next[${i}].target`,
					});
				} else if (!stepIds.has(edge.target)) {
					errors.push({
						type: "invalid_edge",
						message: `Edge target '${edge.target}' does not exist`,
						path: `steps.${stepId}.next[${i}].target`,
					});
				}

				// Validate condition syntax if present
				if (
					edge.condition !== undefined &&
					edge.condition !== null &&
					typeof edge.condition === "string"
				) {
					if (!validateCondition(edge.condition)) {
						errors.push({
							type: "invalid_condition",
							message: `Invalid condition syntax: ${edge.condition}`,
							path: `steps.${stepId}.next[${i}].condition`,
						});
					}
				}
			});
		}
	}

	// Validate initial_step references valid step
	if (typeof raw.initial_step === "string" && !stepIds.has(raw.initial_step)) {
		errors.push({
			type: "invalid_step",
			message: `Initial step '${raw.initial_step}' does not exist`,
			path: "initial_step",
		});
	}

	// Validate terminal_steps reference valid steps
	if (Array.isArray(raw.terminal_steps)) {
		raw.terminal_steps.forEach((terminalStep, i) => {
			if (typeof terminalStep === "string" && !stepIds.has(terminalStep)) {
				errors.push({
					type: "invalid_step",
					message: `Terminal step '${terminalStep}' does not exist`,
					path: `terminal_steps[${i}]`,
				});
			}
		});
	}

	return { valid: errors.length === 0, errors, warnings: [] };
}

// =============================================================================
// Transformation
// =============================================================================

function transformToWorkflowDefinition(
	raw: RawTomlWorkflow,
): WorkflowDefinition {
	const steps: WorkflowStep[] = [];

	for (const [stepId, rawStep] of Object.entries(raw.steps || {})) {
		const edges: StepEdge[] = [];

		if (rawStep.next && Array.isArray(rawStep.next)) {
			for (const rawEdge of rawStep.next) {
				edges.push({
					target: String(rawEdge.target),
					condition:
						rawEdge.condition === undefined || rawEdge.condition === null
							? null
							: String(rawEdge.condition),
					label: rawEdge.label ? String(rawEdge.label) : undefined,
				});
			}
		}

		steps.push({
			id: stepId,
			name: String(rawStep.name),
			description: rawStep.description
				? String(rawStep.description)
				: undefined,
			outputs: Array.isArray(rawStep.outputs)
				? rawStep.outputs.map(String)
				: [],
			next: edges,
		});
	}

	return {
		name: String(raw.name),
		version: String(raw.version),
		description: String(raw.description),
		steps,
		initial_step: String(raw.initial_step),
		terminal_steps: (raw.terminal_steps as unknown[]).map(String),
	};
}
