/**
 * Workflow module exports
 *
 * Provides types and utilities for GSD workflow routing.
 */

// Executor functions
export {
	createCliContext,
	createMockContext,
	createStepPromptTOON,
	executeStep,
	executeWorkflow,
	outputStepPrompt,
	type ExecuteResult,
	type ExecutorContext,
	type StepPromptTOON,
} from "./executor.js";
// Instance storage functions
export {
	createInstance,
	deleteInstance,
	generateInstanceId,
	getActiveInstance,
	INSTANCE_PATHS,
	listInstances,
	loadInstance,
	saveInstance,
} from "./instance.js";
// TOML parser functions
export {
	loadWorkflowFile,
	parseWorkflow,
	validateCondition,
	validateWorkflow,
} from "./parser.js";
// Routing and condition evaluation
export {
	advanceToStep,
	evaluateCondition,
	getNextSteps,
	isTerminalStep,
	parseConditionExpr,
	selectNextStep,
} from "./routing.js";
// TOON serialization functions
export {
	advanceWorkflowStep,
	createWorkflowInstance,
	parseWorkflowState,
	serializeWorkflowState,
} from "./toon.js";
// Types
// Re-export NextStep type from types
export type {
	ConditionNode,
	ConditionOperator,
	NextStep,
	ParsedToonState,
	StepEdge,
	WorkflowDefinition,
	WorkflowInstance,
	WorkflowStep,
	WorkflowValidationError,
	WorkflowValidationResult,
} from "./types.js";
