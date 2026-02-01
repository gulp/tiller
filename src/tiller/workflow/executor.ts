/**
 * Workflow Executor
 *
 * Automatically advances workflow steps based on collected outputs.
 * Designed for:
 * - Interactive CLI mode (--interactive flag)
 * - Testing with mocked output collection
 * - Agent-driven execution with TOON prompts
 *
 * ADR Compliance:
 * - 0003: TOON-first output via createStepPromptTOON
 */

import { logEvent } from "../state/events.js";
import { outputTOON } from "../types/toon.js";
import { saveInstance } from "./instance.js";
import {
	advanceToStep,
	getNextSteps,
	isTerminalStep,
	selectNextStep,
} from "./routing.js";
import type {
	NextStep,
	WorkflowDefinition,
	WorkflowInstance,
	WorkflowStep,
} from "./types.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Context for workflow execution.
 * Provides hooks for step execution and output collection.
 * Design allows dependency injection for testing.
 */
export interface ExecutorContext {
	/**
	 * Called before each step starts.
	 * Use to present step instructions to the agent.
	 */
	onStepStart?: (
		step: WorkflowStep,
		instance: WorkflowInstance,
		def: WorkflowDefinition,
	) => Promise<void>;

	/**
	 * Collect outputs for the current step.
	 * Returns key-value pairs to add to workflow state.
	 * Return null to abort the workflow.
	 *
	 * For testing: mock this to return predefined outputs.
	 * For CLI: implement readline or AskUserQuestion-style prompts.
	 */
	collectOutputs: (
		step: WorkflowStep,
		instance: WorkflowInstance,
		def: WorkflowDefinition,
	) => Promise<Record<string, unknown> | null>;

	/**
	 * Called when a step is completed.
	 */
	onStepComplete?: (
		step: WorkflowStep,
		instance: WorkflowInstance,
		outputs: Record<string, unknown>,
	) => Promise<void>;

	/**
	 * Called when workflow completes (reaches terminal step).
	 */
	onWorkflowComplete?: (instance: WorkflowInstance) => Promise<void>;

	/**
	 * Called on error.
	 */
	onError?: (
		error: Error,
		step: WorkflowStep | null,
		instance: WorkflowInstance,
	) => Promise<void>;
}

/**
 * Result of workflow execution.
 */
export interface ExecuteResult {
	/** Whether workflow completed successfully */
	success: boolean;

	/** Final workflow instance state */
	instance: WorkflowInstance;

	/** Error message if failed */
	error?: string;

	/** Number of steps completed in this execution */
	stepsCompleted: number;

	/** Whether workflow reached a terminal step */
	isTerminal: boolean;
}

/**
 * TOON structure for step prompts.
 */
export interface StepPromptTOON {
	workflow_step: {
		workflow: string;
		instance_id: string;
		step_id: string;
		step_name: string;
		instructions: string | null;
		expected_outputs: string[];
		state: Record<string, unknown>;
		history: string[];
		available_transitions: Array<{
			target: string;
			target_name: string;
			condition: string | null;
			condition_met: boolean;
			is_default: boolean;
		}>;
		is_terminal: boolean;
	};
	agent_hint: string;
}

// =============================================================================
// Core Execution
// =============================================================================

/**
 * Execute a workflow from current position.
 *
 * Loops through steps, collecting outputs and advancing automatically
 * until reaching a terminal step or encountering an error.
 *
 * @param def - Workflow definition
 * @param instance - Current workflow instance
 * @param ctx - Executor context with callbacks
 * @returns Execution result with final instance state
 */
export async function executeWorkflow(
	def: WorkflowDefinition,
	instance: WorkflowInstance,
	ctx: ExecutorContext,
): Promise<ExecuteResult> {
	let current = instance;
	let stepsCompleted = 0;

	try {
		// Check if already at terminal step
		if (isTerminalStep(def, current.current_step)) {
			if (ctx.onWorkflowComplete) {
				await ctx.onWorkflowComplete(current);
			}
			return {
				success: true,
				instance: current,
				stepsCompleted: 0,
				isTerminal: true,
			};
		}

		// Main execution loop
		while (!isTerminalStep(def, current.current_step)) {
			const step = def.steps.find((s) => s.id === current.current_step);
			if (!step) {
				return {
					success: false,
					instance: current,
					error: `Step not found in workflow: ${current.current_step}`,
					stepsCompleted,
					isTerminal: false,
				};
			}

			// Notify step start
			if (ctx.onStepStart) {
				await ctx.onStepStart(step, current, def);
			}

			// Collect outputs from agent/user
			const outputs = await ctx.collectOutputs(step, current, def);
			if (outputs === null) {
				// Workflow aborted by user
				logEvent({
					event: "workflow_aborted",
					instance: current.id,
					workflow: current.workflow_name,
					step: current.current_step,
					reason: "user_abort",
				});
				return {
					success: false,
					instance: current,
					error: "Workflow aborted by user",
					stepsCompleted,
					isTerminal: false,
				};
			}

			// Update state with outputs
			const previousStep = current.current_step;
			current = {
				...current,
				state: { ...current.state, ...outputs },
				updated_at: new Date().toISOString(),
			};

			// Select next step based on conditions
			const nextStepId = selectNextStep(def, current);

			// Notify step complete
			if (ctx.onStepComplete) {
				await ctx.onStepComplete(step, current, outputs);
			}

			// Log step completion
			logEvent({
				event: "step_completed",
				instance: current.id,
				workflow: current.workflow_name,
				from: previousStep,
				to: nextStepId ?? "(terminal)",
				outputs: Object.keys(outputs).join(", ") || "(none)",
			});

			// Advance to next step if available
			if (nextStepId) {
				current = advanceToStep(current, nextStepId);
			} else if (!isTerminalStep(def, current.current_step)) {
				// No valid transition and not terminal - this is an error
				return {
					success: false,
					instance: current,
					error: `No valid transition from step "${current.current_step}" with current state`,
					stepsCompleted,
					isTerminal: false,
				};
			}

			// Save state after each step
			await saveInstance(current);
			stepsCompleted++;
		}

		// Workflow completed - at terminal step
		if (ctx.onWorkflowComplete) {
			await ctx.onWorkflowComplete(current);
		}

		logEvent({
			event: "workflow_completed",
			instance: current.id,
			workflow: current.workflow_name,
			final_step: current.current_step,
			total_steps: current.history.length,
		});

		return {
			success: true,
			instance: current,
			stepsCompleted,
			isTerminal: true,
		};
	} catch (error) {
		const step = def.steps.find((s) => s.id === current.current_step) ?? null;
		if (ctx.onError) {
			await ctx.onError(error as Error, step, current);
		}

		logEvent({
			event: "workflow_error",
			instance: current.id,
			workflow: current.workflow_name,
			step: current.current_step,
			error: (error as Error).message,
		});

		return {
			success: false,
			instance: current,
			error: (error as Error).message,
			stepsCompleted,
			isTerminal: false,
		};
	}
}

/**
 * Execute a single step and advance.
 *
 * Useful for step-by-step execution where control returns to caller
 * between steps (e.g., agent-driven execution).
 *
 * @param def - Workflow definition
 * @param instance - Current workflow instance
 * @param outputs - Outputs for current step
 * @returns Updated instance and execution info
 */
export async function executeStep(
	def: WorkflowDefinition,
	instance: WorkflowInstance,
	outputs: Record<string, unknown>,
): Promise<{
	instance: WorkflowInstance;
	previousStep: string;
	nextStep: string | null;
	isTerminal: boolean;
	error?: string;
}> {
	const previousStep = instance.current_step;

	// Verify current step exists
	const step = def.steps.find((s) => s.id === instance.current_step);
	if (!step) {
		return {
			instance,
			previousStep,
			nextStep: null,
			isTerminal: false,
			error: `Step not found: ${instance.current_step}`,
		};
	}

	// Update state
	let current: WorkflowInstance = {
		...instance,
		state: { ...instance.state, ...outputs },
		updated_at: new Date().toISOString(),
	};

	// Select next step
	const nextStepId = selectNextStep(def, current);

	// Check if we're at terminal
	const isTerminal = isTerminalStep(def, current.current_step);

	// Advance if next step available
	if (nextStepId) {
		current = advanceToStep(current, nextStepId);
	}

	// Save state
	await saveInstance(current);

	// Log event
	logEvent({
		event: "step_completed",
		instance: current.id,
		workflow: current.workflow_name,
		from: previousStep,
		to: nextStepId ?? "(terminal)",
		outputs: Object.keys(outputs).join(", ") || "(none)",
	});

	return {
		instance: current,
		previousStep,
		nextStep: nextStepId,
		isTerminal: isTerminal || isTerminalStep(def, current.current_step),
	};
}

// =============================================================================
// TOON Output
// =============================================================================

/**
 * Create a TOON prompt for a workflow step.
 *
 * Includes all information an agent needs to execute the step:
 * - Instructions (description)
 * - Expected outputs
 * - Current state
 * - Available transitions with condition status
 */
export function createStepPromptTOON(
	def: WorkflowDefinition,
	instance: WorkflowInstance,
	step: WorkflowStep,
): StepPromptTOON {
	const nextSteps = getNextSteps(def, instance);
	const isTerminal = isTerminalStep(def, step.id);

	// Build transition info with target names
	const transitions = nextSteps.map((ns: NextStep) => {
		const targetStep = def.steps.find((s) => s.id === ns.step_id);
		return {
			target: ns.step_id,
			target_name: targetStep?.name ?? ns.step_id,
			condition: ns.condition,
			condition_met: ns.condition_met,
			is_default: ns.is_default,
		};
	});

	// Build agent hint based on expected outputs
	const expectedOutputs = step.outputs ?? [];
	const outputHint =
		expectedOutputs.length > 0
			? `After completing this step, record outputs with: tiller step done ${expectedOutputs.map((o) => `--set ${o}=<value>`).join(" ")}`
			: "After completing this step, advance with: tiller step done";

	return {
		workflow_step: {
			workflow: def.name,
			instance_id: instance.id,
			step_id: step.id,
			step_name: step.name,
			instructions: step.description ?? null,
			expected_outputs: expectedOutputs,
			state: instance.state,
			history: instance.history,
			available_transitions: transitions,
			is_terminal: isTerminal,
		},
		agent_hint: outputHint,
	};
}

/**
 * Output step prompt in TOON format.
 */
export function outputStepPrompt(
	def: WorkflowDefinition,
	instance: WorkflowInstance,
	step: WorkflowStep,
): void {
	const toon = createStepPromptTOON(def, instance, step);
	outputTOON(toon, { agent_hint: toon.agent_hint });
}

// =============================================================================
// Context Factories
// =============================================================================

/**
 * Create a CLI context for interactive execution.
 *
 * Outputs step prompts in TOON format and collects outputs
 * via readline prompts.
 */
export function createCliContext(options?: {
	/** Custom output function (default: console.log) */
	log?: (message: string) => void;
	/** Skip TOON output (for quiet mode) */
	quiet?: boolean;
}): ExecutorContext {
	const log = options?.log ?? console.log;
	const quiet = options?.quiet ?? false;

	return {
		async onStepStart(step, instance, def) {
			if (!quiet) {
				outputStepPrompt(def, instance, step);
			}
		},

		async collectOutputs(_step, _instance, _def) {
			// In CLI mode, the agent executes the step and calls back
			// with tiller step done --set key=value
			//
			// For interactive mode, we would prompt for each expected output.
			// This is a placeholder - actual readline implementation would
			// be in the workflow command that uses this context.
			//
			// Return empty outputs - the step done command handles collection
			return {};
		},

		async onStepComplete(step, _instance, outputs) {
			if (!quiet) {
				const outputKeys = Object.keys(outputs);
				if (outputKeys.length > 0) {
					log(`Step "${step.name}" completed with: ${outputKeys.join(", ")}`);
				} else {
					log(`Step "${step.name}" completed`);
				}
			}
		},

		async onWorkflowComplete(instance) {
			log("");
			log(`Workflow completed: ${instance.workflow_name}`);
			log(`Final step: ${instance.current_step}`);
			log(`Steps visited: ${instance.history.length}`);
		},

		async onError(error, step, _instance) {
			const stepInfo = step ? ` at step "${step.name}"` : "";
			log(`Error${stepInfo}: ${error.message}`);
		},
	};
}

/**
 * Create a mock context for testing.
 *
 * Accepts a sequence of outputs to return for each step.
 * Useful for unit testing workflow execution.
 *
 * @param outputSequence - Array of outputs, one per step
 * @returns Executor context and collected events
 */
export function createMockContext(
	outputSequence: Array<Record<string, unknown> | null>,
): {
	context: ExecutorContext;
	events: Array<{
		type: "step_start" | "step_complete" | "workflow_complete" | "error";
		step?: string;
		outputs?: Record<string, unknown>;
		error?: string;
	}>;
} {
	let outputIndex = 0;
	const events: Array<{
		type: "step_start" | "step_complete" | "workflow_complete" | "error";
		step?: string;
		outputs?: Record<string, unknown>;
		error?: string;
	}> = [];

	const context: ExecutorContext = {
		async onStepStart(step, _instance, _def) {
			events.push({ type: "step_start", step: step.id });
		},

		async collectOutputs(_step, _instance, _def) {
			if (outputIndex >= outputSequence.length) {
				// No more outputs - return empty to continue
				return {};
			}
			return outputSequence[outputIndex++];
		},

		async onStepComplete(step, _instance, outputs) {
			events.push({ type: "step_complete", step: step.id, outputs });
		},

		async onWorkflowComplete(_instance) {
			events.push({ type: "workflow_complete" });
		},

		async onError(error, step, _instance) {
			events.push({ type: "error", step: step?.id, error: error.message });
		},
	};

	return { context, events };
}
