/**
 * TOON (Token-Optimized Notation) Serializer
 *
 * Provides compact serialization of workflow state for efficient runtime
 * injection into agent context. TOON format is ~40% smaller than JSON
 * while remaining human-readable for debugging.
 *
 * Format:
 *   WF:workflow-name@current-step
 *   ST:key1=value1|key2=value2
 *   HX:step1>step2>step3
 *   NX:next1[condition]|next2[default]
 */

import type {
	ParsedToonState,
	WorkflowDefinition,
	WorkflowInstance,
} from "./types.js";

/**
 * Serialize workflow instance state to TOON format.
 */
export function serializeWorkflowState(
	def: WorkflowDefinition,
	instance: WorkflowInstance,
): string {
	const lines: string[] = [];

	// WF: workflow name @ current step
	lines.push(`WF:${instance.workflow_name}@${instance.current_step}`);

	// ST: state as key=value pairs
	const stateEntries = Object.entries(instance.state);
	if (stateEntries.length > 0) {
		const statePairs = stateEntries.map(([key, value]) => {
			return `${key}=${serializeValue(value)}`;
		});
		lines.push(`ST:${statePairs.join("|")}`);
	}

	// HX: history as step chain
	if (instance.history.length > 0) {
		lines.push(`HX:${instance.history.join(">")}`);
	}

	// NX: next steps with conditions
	const currentStep = def.steps.find((s) => s.id === instance.current_step);
	if (currentStep && currentStep.next.length > 0) {
		const nextParts = currentStep.next.map((edge) => {
			const condition = edge.condition ?? "default";
			return `${edge.target}[${condition}]`;
		});
		lines.push(`NX:${nextParts.join("|")}`);
	}

	return lines.join("\n");
}

function serializeValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "null";
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (typeof value === "number") {
		return String(value);
	}
	if (typeof value === "string") {
		return value.replace(/[|=>[\]]/g, (c) => `\\${c}`);
	}
	if (Array.isArray(value)) {
		return `[${value.map(serializeValue).join(",")}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		const parts = entries.map(([k, v]) => `${k}:${serializeValue(v)}`);
		return `{${parts.join(",")}}`;
	}
	return String(value);
}

/**
 * Parse TOON-formatted string back to structured state.
 */
export function parseWorkflowState(toon: string): ParsedToonState {
	const lines = toon.trim().split("\n");
	const result: ParsedToonState = {
		workflow: "",
		step: "",
		state: {},
		history: [],
		next: [],
	};

	for (const line of lines) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const prefix = line.slice(0, colonIdx);
		const content = line.slice(colonIdx + 1);

		switch (prefix) {
			case "WF":
				parseWfLine(content, result);
				break;
			case "ST":
				parseStLine(content, result);
				break;
			case "HX":
				parseHxLine(content, result);
				break;
			case "NX":
				parseNxLine(content, result);
				break;
		}
	}

	return result;
}

function parseWfLine(content: string, result: ParsedToonState): void {
	const atIdx = content.indexOf("@");
	if (atIdx === -1) {
		result.workflow = content;
		result.step = "";
	} else {
		result.workflow = content.slice(0, atIdx);
		result.step = content.slice(atIdx + 1);
	}
}

function parseStLine(content: string, result: ParsedToonState): void {
	if (!content) return;
	const pairs = splitUnescaped(content, "|");
	for (const pair of pairs) {
		const eqIdx = findUnescaped(pair, "=");
		if (eqIdx === -1) continue;
		const key = pair.slice(0, eqIdx);
		const valueStr = pair.slice(eqIdx + 1);
		result.state[key] = parseValue(valueStr);
	}
}

function parseHxLine(content: string, result: ParsedToonState): void {
	if (!content) return;
	result.history = content.split(">");
}

function parseNxLine(content: string, result: ParsedToonState): void {
	if (!content) return;
	const parts = splitUnescaped(content, "|");
	for (const part of parts) {
		const bracketIdx = part.indexOf("[");
		if (bracketIdx === -1) {
			result.next.push({ step: part, condition: null });
		} else {
			const step = part.slice(0, bracketIdx);
			const conditionEnd = part.lastIndexOf("]");
			const condition = part.slice(bracketIdx + 1, conditionEnd);
			result.next.push({
				step,
				condition: condition === "default" ? null : condition,
			});
		}
	}
}

function parseValue(str: string): unknown {
	if (str === "null") return null;
	if (str === "true") return true;
	if (str === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(str)) {
		return parseFloat(str);
	}
	if (str.startsWith("[") && str.endsWith("]")) {
		const inner = str.slice(1, -1);
		if (!inner) return [];
		return splitUnescaped(inner, ",").map(parseValue);
	}
	if (str.startsWith("{") && str.endsWith("}")) {
		const inner = str.slice(1, -1);
		if (!inner) return {};
		const obj: Record<string, unknown> = {};
		const pairs = splitUnescaped(inner, ",");
		for (const pair of pairs) {
			const colonIdx = pair.indexOf(":");
			if (colonIdx === -1) continue;
			const key = pair.slice(0, colonIdx);
			const value = pair.slice(colonIdx + 1);
			obj[key] = parseValue(value);
		}
		return obj;
	}
	return str.replace(/\\([|=>[\]])/g, "$1");
}

function splitUnescaped(str: string, delimiter: string): string[] {
	const results: string[] = [];
	let current = "";
	let i = 0;
	let depth = 0;

	while (i < str.length) {
		const char = str[i];
		if (char === "[" || char === "{") depth++;
		if (char === "]" || char === "}") depth--;
		if (char === "\\" && i + 1 < str.length) {
			current += char + str[i + 1];
			i += 2;
			continue;
		}
		if (depth === 0 && str.slice(i, i + delimiter.length) === delimiter) {
			results.push(current);
			current = "";
			i += delimiter.length;
			continue;
		}
		current += char;
		i++;
	}
	if (current) {
		results.push(current);
	}
	return results;
}

function findUnescaped(str: string, char: string): number {
	let i = 0;
	while (i < str.length) {
		if (str[i] === "\\" && i + 1 < str.length) {
			i += 2;
			continue;
		}
		if (str[i] === char) {
			return i;
		}
		i++;
	}
	return -1;
}

export function createWorkflowInstance(
	def: WorkflowDefinition,
	id?: string,
): WorkflowInstance {
	const now = new Date().toISOString();
	return {
		id: id ?? crypto.randomUUID(),
		workflow_name: def.name,
		current_step: def.initial_step,
		state: {},
		history: [def.initial_step],
		started_at: now,
		updated_at: now,
	};
}

export function advanceWorkflowStep(
	instance: WorkflowInstance,
	newStep: string,
	stateUpdates?: Record<string, unknown>,
): WorkflowInstance {
	return {
		...instance,
		current_step: newStep,
		state: { ...instance.state, ...stateUpdates },
		history: [...instance.history, newStep],
		updated_at: new Date().toISOString(),
	};
}
