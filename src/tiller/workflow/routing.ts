/**
 * Workflow Routing and Condition Evaluation
 *
 * Provides condition expression evaluation and step routing logic
 * for deterministic workflow advancement.
 */

import type {
	ConditionNode,
	NextStep,
	WorkflowDefinition,
	WorkflowInstance,
} from "./types.js";

// =============================================================================
// Condition Parsing
// =============================================================================

/**
 * Parse a condition expression string into an AST.
 *
 * Grammar:
 * - exists(key)
 * - eq(key, value)
 * - contains(key, value)
 * - and(cond1, cond2)
 * - or(cond1, cond2)
 * - not(cond)
 * - true / false
 *
 * @throws Error on syntax errors
 */
export function parseConditionExpr(expr: string): ConditionNode {
	const trimmed = expr.trim();

	// Handle literal true/false
	if (trimmed === "true") {
		return { type: "literal", value: true };
	}
	if (trimmed === "false") {
		return { type: "literal", value: false };
	}

	// Parse function call: operator(args)
	const match = trimmed.match(/^(\w+)\s*\((.*)\)$/s);
	if (!match) {
		throw new Error(`Invalid condition syntax: ${trimmed}`);
	}

	const operator = match[1];
	const argsStr = match[2];

	switch (operator) {
		case "exists":
			return parseExistsExpr(argsStr);
		case "eq":
			return parseEqExpr(argsStr);
		case "contains":
			return parseContainsExpr(argsStr);
		case "and":
			return parseAndExpr(argsStr);
		case "or":
			return parseOrExpr(argsStr);
		case "not":
			return parseNotExpr(argsStr);
		default:
			throw new Error(`Unknown operator: ${operator}`);
	}
}

function parseExistsExpr(argsStr: string): ConditionNode {
	const key = argsStr.trim();
	if (!key) {
		throw new Error("exists() requires a key argument");
	}
	return { type: "exists", key };
}

function parseEqExpr(argsStr: string): ConditionNode {
	const commaIdx = findTopLevelComma(argsStr);
	if (commaIdx === -1) {
		throw new Error("eq() requires two arguments: key, value");
	}
	const key = argsStr.slice(0, commaIdx).trim();
	const value = parseStringArg(argsStr.slice(commaIdx + 1).trim());
	return { type: "eq", key, value };
}

function parseContainsExpr(argsStr: string): ConditionNode {
	const commaIdx = findTopLevelComma(argsStr);
	if (commaIdx === -1) {
		throw new Error("contains() requires two arguments: key, value");
	}
	const key = argsStr.slice(0, commaIdx).trim();
	const value = parseStringArg(argsStr.slice(commaIdx + 1).trim());
	return { type: "contains", key, value };
}

function parseAndExpr(argsStr: string): ConditionNode {
	const commaIdx = findTopLevelComma(argsStr);
	if (commaIdx === -1) {
		throw new Error("and() requires two arguments");
	}
	const left = parseConditionExpr(argsStr.slice(0, commaIdx));
	const right = parseConditionExpr(argsStr.slice(commaIdx + 1));
	return { type: "and", left, right };
}

function parseOrExpr(argsStr: string): ConditionNode {
	const commaIdx = findTopLevelComma(argsStr);
	if (commaIdx === -1) {
		throw new Error("or() requires two arguments");
	}
	const left = parseConditionExpr(argsStr.slice(0, commaIdx));
	const right = parseConditionExpr(argsStr.slice(commaIdx + 1));
	return { type: "or", left, right };
}

function parseNotExpr(argsStr: string): ConditionNode {
	const operand = parseConditionExpr(argsStr);
	return { type: "not", operand };
}

/**
 * Parse a string argument, stripping quotes if present.
 */
function parseStringArg(arg: string): string {
	const trimmed = arg.trim();
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Find the index of the top-level comma (not inside nested parens or quotes).
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
// Condition Evaluation
// =============================================================================

/**
 * Evaluate a condition expression against workflow state.
 *
 * @param condition - Condition expression string (null = always true)
 * @param state - Workflow instance state
 * @returns Whether the condition is satisfied
 */
export function evaluateCondition(
	condition: string | null,
	state: Record<string, unknown>,
): boolean {
	// Null condition = default edge (always true)
	if (condition === null) {
		return true;
	}

	const ast = parseConditionExpr(condition);
	return evaluateNode(ast, state);
}

/**
 * Evaluate an AST node against state.
 */
function evaluateNode(
	node: ConditionNode,
	state: Record<string, unknown>,
): boolean {
	switch (node.type) {
		case "literal":
			return node.value;

		case "exists":
			return state[node.key] !== undefined && state[node.key] !== null;

		case "eq": {
			const actual = state[node.key];
			return String(actual) === node.value;
		}

		case "contains": {
			const arr = state[node.key];
			if (!Array.isArray(arr)) return false;
			return arr.some((item) => String(item) === node.value);
		}

		case "and":
			return evaluateNode(node.left, state) && evaluateNode(node.right, state);

		case "or":
			return evaluateNode(node.left, state) || evaluateNode(node.right, state);

		case "not":
			return !evaluateNode(node.operand, state);

		default:
			return false;
	}
}

// =============================================================================
// Step Routing
// =============================================================================

/**
 * Get available next steps from current position with condition status.
 */
export function getNextSteps(
	def: WorkflowDefinition,
	instance: WorkflowInstance,
): NextStep[] {
	const currentStep = def.steps.find((s) => s.id === instance.current_step);
	if (!currentStep) {
		return [];
	}

	const results: NextStep[] = [];

	for (const edge of currentStep.next) {
		const targetStep = def.steps.find((s) => s.id === edge.target);
		const conditionMet = evaluateCondition(edge.condition, instance.state);
		const isDefault = edge.condition === null;

		results.push({
			step_id: edge.target,
			step_name: targetStep?.name ?? edge.target,
			condition: edge.condition,
			condition_met: conditionMet,
			is_default: isDefault,
		});
	}

	// Sort: met conditions first, then by default status (default last)
	results.sort((a, b) => {
		// Met conditions come first
		if (a.condition_met !== b.condition_met) {
			return a.condition_met ? -1 : 1;
		}
		// Among equally met/unmet, default edges come last
		if (a.is_default !== b.is_default) {
			return a.is_default ? 1 : -1;
		}
		return 0;
	});

	return results;
}

/**
 * Select the next step based on conditions.
 * Returns null if no valid transition is available.
 */
export function selectNextStep(
	def: WorkflowDefinition,
	instance: WorkflowInstance,
): string | null {
	const nextSteps = getNextSteps(def, instance);

	// Find first step where condition is met
	for (const step of nextSteps) {
		if (step.condition_met) {
			return step.step_id;
		}
	}

	return null;
}

/**
 * Check if a step is a terminal step.
 */
export function isTerminalStep(
	def: WorkflowDefinition,
	stepId: string,
): boolean {
	return def.terminal_steps.includes(stepId);
}

/**
 * Advance workflow instance to a new step.
 * Returns a new instance object (does not mutate original).
 */
export function advanceToStep(
	instance: WorkflowInstance,
	stepId: string,
): WorkflowInstance {
	return {
		...instance,
		current_step: stepId,
		history: [...instance.history, stepId],
		updated_at: new Date().toISOString(),
	};
}
