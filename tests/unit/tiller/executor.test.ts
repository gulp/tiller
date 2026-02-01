/**
 * Tests for workflow executor
 *
 * Validates that the executor:
 * - Advances steps automatically with mock outputs
 * - Handles terminal steps correctly
 * - Respects conditions for step transitions
 * - Reports errors appropriately
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock @toon-format/toon before importing executor
vi.mock("@toon-format/toon", () => ({
	DELIMITERS: { tab: "\t" },
	encode: (data: unknown) => JSON.stringify(data, null, 2),
}));

// Mock saveInstance to avoid file system operations
vi.mock("../../../src/tiller/workflow/instance.js", () => ({
	saveInstance: vi.fn().mockResolvedValue(undefined),
}));

// Mock logEvent to avoid file system operations
vi.mock("../../../src/tiller/state/events.js", () => ({
	logEvent: vi.fn(),
}));

// Mock outputTOON to avoid console output
vi.mock("../../../src/tiller/types/toon.js", () => ({
	outputTOON: vi.fn(),
}));

import {
	createMockContext,
	createStepPromptTOON,
	executeStep,
	executeWorkflow,
	type ExecutorContext,
} from "../../../src/tiller/workflow/executor.js";
import type {
	WorkflowDefinition,
	WorkflowInstance,
} from "../../../src/tiller/workflow/types.js";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * Simple two-step workflow for basic tests.
 */
const simpleWorkflow: WorkflowDefinition = {
	name: "simple-test",
	version: "1.0",
	description: "A simple two-step workflow for testing",
	initial_step: "step-a",
	terminal_steps: ["step-b"],
	steps: [
		{
			id: "step-a",
			name: "Step A",
			description: "First step",
			outputs: ["output_a"],
			next: [{ target: "step-b", condition: null }],
		},
		{
			id: "step-b",
			name: "Step B",
			description: "Terminal step",
			outputs: [],
			next: [],
		},
	],
};

/**
 * Workflow with conditional branching.
 */
const conditionalWorkflow: WorkflowDefinition = {
	name: "conditional-test",
	version: "1.0",
	description: "Workflow with conditional branching",
	initial_step: "start",
	terminal_steps: ["success", "failure"],
	steps: [
		{
			id: "start",
			name: "Start",
			description: "Initial step",
			outputs: ["proceed"],
			next: [
				{ target: "success", condition: "eq(proceed, 'yes')" },
				{ target: "failure", condition: "eq(proceed, 'no')" },
				{ target: "failure", condition: null }, // default
			],
		},
		{
			id: "success",
			name: "Success",
			description: "Success terminal",
			outputs: [],
			next: [],
		},
		{
			id: "failure",
			name: "Failure",
			description: "Failure terminal",
			outputs: [],
			next: [],
		},
	],
};

/**
 * Multi-step workflow for testing advancement.
 */
const multiStepWorkflow: WorkflowDefinition = {
	name: "multi-step-test",
	version: "1.0",
	description: "Multiple steps for testing",
	initial_step: "one",
	terminal_steps: ["four"],
	steps: [
		{
			id: "one",
			name: "Step One",
			description: "First",
			outputs: ["value_one"],
			next: [{ target: "two", condition: null }],
		},
		{
			id: "two",
			name: "Step Two",
			description: "Second",
			outputs: ["value_two"],
			next: [{ target: "three", condition: null }],
		},
		{
			id: "three",
			name: "Step Three",
			description: "Third",
			outputs: ["value_three"],
			next: [{ target: "four", condition: null }],
		},
		{
			id: "four",
			name: "Step Four",
			description: "Terminal",
			outputs: [],
			next: [],
		},
	],
};

function createInstance(
	workflow: WorkflowDefinition,
	overrides?: Partial<WorkflowInstance>,
): WorkflowInstance {
	return {
		id: `${workflow.name}-test-123`,
		workflow_name: workflow.name,
		current_step: workflow.initial_step,
		state: {},
		history: [workflow.initial_step],
		started_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		...overrides,
	};
}

// =============================================================================
// Tests
// =============================================================================

describe("executeWorkflow", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	test("advances steps automatically with mock outputs", async () => {
		const { context, events } = createMockContext([{ output_a: "value_a" }]);

		const instance = createInstance(simpleWorkflow);
		const result = await executeWorkflow(simpleWorkflow, instance, context);

		expect(result.success).toBe(true);
		expect(result.isTerminal).toBe(true);
		expect(result.stepsCompleted).toBe(1);
		expect(result.instance.current_step).toBe("step-b");
		expect(result.instance.state).toEqual({ output_a: "value_a" });

		// Verify events were fired
		expect(events).toContainEqual({ type: "step_start", step: "step-a" });
		expect(events).toContainEqual({
			type: "step_complete",
			step: "step-a",
			outputs: { output_a: "value_a" },
		});
		expect(events).toContainEqual({ type: "workflow_complete" });
	});

	test("handles terminal step at start", async () => {
		const { context, events } = createMockContext([]);

		const instance = createInstance(simpleWorkflow, {
			current_step: "step-b",
			history: ["step-a", "step-b"],
		});
		const result = await executeWorkflow(simpleWorkflow, instance, context);

		expect(result.success).toBe(true);
		expect(result.isTerminal).toBe(true);
		expect(result.stepsCompleted).toBe(0);
		expect(events).toContainEqual({ type: "workflow_complete" });
	});

	test("respects conditions for step transitions", async () => {
		// Test success path
		const { context: successContext } = createMockContext([
			{ proceed: "yes" },
		]);
		const successInstance = createInstance(conditionalWorkflow);
		const successResult = await executeWorkflow(
			conditionalWorkflow,
			successInstance,
			successContext,
		);

		expect(successResult.success).toBe(true);
		expect(successResult.instance.current_step).toBe("success");

		// Test failure path
		const { context: failureContext } = createMockContext([{ proceed: "no" }]);
		const failureInstance = createInstance(conditionalWorkflow);
		const failureResult = await executeWorkflow(
			conditionalWorkflow,
			failureInstance,
			failureContext,
		);

		expect(failureResult.success).toBe(true);
		expect(failureResult.instance.current_step).toBe("failure");
	});

	test("uses default transition when no condition matches", async () => {
		const { context } = createMockContext([{ proceed: "maybe" }]);
		const instance = createInstance(conditionalWorkflow);
		const result = await executeWorkflow(
			conditionalWorkflow,
			instance,
			context,
		);

		expect(result.success).toBe(true);
		// Default edge goes to failure
		expect(result.instance.current_step).toBe("failure");
	});

	test("advances through multiple steps", async () => {
		const { context, events } = createMockContext([
			{ value_one: 1 },
			{ value_two: 2 },
			{ value_three: 3 },
		]);

		const instance = createInstance(multiStepWorkflow);
		const result = await executeWorkflow(multiStepWorkflow, instance, context);

		expect(result.success).toBe(true);
		expect(result.stepsCompleted).toBe(3);
		expect(result.instance.current_step).toBe("four");
		expect(result.instance.state).toEqual({
			value_one: 1,
			value_two: 2,
			value_three: 3,
		});
		expect(result.instance.history).toEqual(["one", "two", "three", "four"]);

		// Verify all step events
		expect(events.filter((e) => e.type === "step_start")).toHaveLength(3);
		expect(events.filter((e) => e.type === "step_complete")).toHaveLength(3);
	});

	test("handles abort (null outputs)", async () => {
		const { context, events } = createMockContext([null]);

		const instance = createInstance(simpleWorkflow);
		const result = await executeWorkflow(simpleWorkflow, instance, context);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Workflow aborted by user");
		expect(result.stepsCompleted).toBe(0);
		// Should not have workflow_complete event
		expect(events).not.toContainEqual({ type: "workflow_complete" });
	});

	test("handles invalid step reference", async () => {
		const { context } = createMockContext([{}]);

		const instance = createInstance(simpleWorkflow, {
			current_step: "nonexistent",
		});
		const result = await executeWorkflow(simpleWorkflow, instance, context);

		expect(result.success).toBe(false);
		expect(result.error).toContain("Step not found");
	});

	test("calls onError callback on exception", async () => {
		const errorCallback = vi.fn();
		const context: ExecutorContext = {
			collectOutputs: async () => {
				throw new Error("Test error");
			},
			onError: errorCallback,
		};

		const instance = createInstance(simpleWorkflow);
		const result = await executeWorkflow(simpleWorkflow, instance, context);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Test error");
		expect(errorCallback).toHaveBeenCalledTimes(1);
		expect(errorCallback).toHaveBeenCalledWith(
			expect.any(Error),
			simpleWorkflow.steps[0],
			expect.any(Object),
		);
	});
});

describe("executeStep", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test("executes single step and advances", async () => {
		const instance = createInstance(simpleWorkflow);
		const result = await executeStep(simpleWorkflow, instance, {
			output_a: "test",
		});

		expect(result.previousStep).toBe("step-a");
		expect(result.nextStep).toBe("step-b");
		expect(result.instance.current_step).toBe("step-b");
		expect(result.instance.state).toEqual({ output_a: "test" });
	});

	test("returns terminal flag when reaching terminal step", async () => {
		const instance = createInstance(simpleWorkflow, {
			current_step: "step-a",
		});
		const result = await executeStep(simpleWorkflow, instance, {});

		expect(result.isTerminal).toBe(true);
	});

	test("returns error for invalid step", async () => {
		const instance = createInstance(simpleWorkflow, {
			current_step: "invalid",
		});
		const result = await executeStep(simpleWorkflow, instance, {});

		expect(result.error).toContain("Step not found");
	});
});

describe("createStepPromptTOON", () => {
	test("creates valid TOON structure", () => {
		const instance = createInstance(simpleWorkflow);
		const step = simpleWorkflow.steps[0];
		const toon = createStepPromptTOON(simpleWorkflow, instance, step);

		expect(toon.workflow_step.workflow).toBe("simple-test");
		expect(toon.workflow_step.step_id).toBe("step-a");
		expect(toon.workflow_step.step_name).toBe("Step A");
		expect(toon.workflow_step.instructions).toBe("First step");
		expect(toon.workflow_step.expected_outputs).toEqual(["output_a"]);
		expect(toon.workflow_step.is_terminal).toBe(false);
	});

	test("includes available transitions with condition status", () => {
		const instance = createInstance(conditionalWorkflow, {
			state: { proceed: "yes" },
		});
		const step = conditionalWorkflow.steps[0];
		const toon = createStepPromptTOON(conditionalWorkflow, instance, step);

		// Should have transitions with condition_met status
		const successTransition = toon.workflow_step.available_transitions.find(
			(t) => t.target === "success",
		);
		expect(successTransition?.condition_met).toBe(true);

		const failureTransition = toon.workflow_step.available_transitions.find(
			(t) => t.target === "failure" && t.condition !== null,
		);
		expect(failureTransition?.condition_met).toBe(false);
	});

	test("includes agent_hint with step done instructions", () => {
		const instance = createInstance(simpleWorkflow);
		const step = simpleWorkflow.steps[0];
		const toon = createStepPromptTOON(simpleWorkflow, instance, step);

		expect(toon.agent_hint).toContain("tiller step done");
		expect(toon.agent_hint).toContain("--set output_a=");
	});

	test("handles step with no outputs", () => {
		const instance = createInstance(simpleWorkflow, {
			current_step: "step-b",
		});
		const step = simpleWorkflow.steps[1];
		const toon = createStepPromptTOON(simpleWorkflow, instance, step);

		expect(toon.workflow_step.expected_outputs).toEqual([]);
		expect(toon.workflow_step.is_terminal).toBe(true);
		expect(toon.agent_hint).not.toContain("--set");
	});
});

describe("createMockContext", () => {
	test("returns outputs in sequence", async () => {
		const outputs = [{ a: 1 }, { b: 2 }, { c: 3 }];
		const { context } = createMockContext(outputs);

		const step = simpleWorkflow.steps[0];
		const instance = createInstance(simpleWorkflow);

		expect(
			await context.collectOutputs(step, instance, simpleWorkflow),
		).toEqual({ a: 1 });
		expect(
			await context.collectOutputs(step, instance, simpleWorkflow),
		).toEqual({ b: 2 });
		expect(
			await context.collectOutputs(step, instance, simpleWorkflow),
		).toEqual({ c: 3 });
	});

	test("returns empty object when sequence exhausted", async () => {
		const { context } = createMockContext([{ first: 1 }]);

		const step = simpleWorkflow.steps[0];
		const instance = createInstance(simpleWorkflow);

		// Exhaust the sequence
		await context.collectOutputs(step, instance, simpleWorkflow);

		// Should return empty object
		expect(
			await context.collectOutputs(step, instance, simpleWorkflow),
		).toEqual({});
	});

	test("records events correctly", async () => {
		const { context, events } = createMockContext([{}]);

		const step = simpleWorkflow.steps[0];
		const instance = createInstance(simpleWorkflow);

		await context.onStepStart?.(step, instance, simpleWorkflow);
		await context.collectOutputs(step, instance, simpleWorkflow);
		await context.onStepComplete?.(step, instance, { test: true });
		await context.onWorkflowComplete?.(instance);

		expect(events).toEqual([
			{ type: "step_start", step: "step-a" },
			{ type: "step_complete", step: "step-a", outputs: { test: true } },
			{ type: "workflow_complete" },
		]);
	});
});
