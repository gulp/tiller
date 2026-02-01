/**
 * Tiller step commands
 *
 * Commands for step-level workflow interaction:
 * - step next: Show current step and available transitions
 * - step done: Complete current step and advance workflow
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { PATHS } from "../state/config.js";
import { logEvent } from "../state/events.js";
import {
	advanceToStep,
	getActiveInstance,
	getNextSteps,
	isTerminalStep,
	loadInstance,
	loadWorkflowFile,
	saveInstance,
	selectNextStep,
	type WorkflowDefinition,
	type WorkflowInstance,
} from "../workflow/index.js";

// Workflow definition locations (derived from PATHS)
const TILLER_WORKFLOWS_DIR = PATHS.WORKFLOWS_DIR;
const BUILTIN_WORKFLOWS_DIR = join(PATHS.PROJECT_ROOT, "src/tiller/workflows");

/**
 * Find a workflow definition file by name.
 */
async function findWorkflowDefinition(
	name: string,
): Promise<WorkflowDefinition | null> {
	const projectPath = join(TILLER_WORKFLOWS_DIR, `${name}.toml`);
	if (existsSync(projectPath)) {
		try {
			return await loadWorkflowFile(projectPath);
		} catch {
			// Fall through
		}
	}

	const builtinPath = join(BUILTIN_WORKFLOWS_DIR, `${name}.toml`);
	if (existsSync(builtinPath)) {
		try {
			return await loadWorkflowFile(builtinPath);
		} catch {
			return null;
		}
	}

	return null;
}

export function registerStepCommands(program: Command): void {
	const step = program
		.command("step")
		.description("Step-level workflow commands");

	// ============================================
	// step next [instance-id]
	// ============================================
	step
		.command("next [instance-id]")
		.description("Show current step and available transitions")
		.option("--json", "Output as JSON")
		.action(
			async (instanceId: string | undefined, options: { json?: boolean }) => {
				// Load instance
				let instance: WorkflowInstance | null;

				if (instanceId) {
					instance = await loadInstance(instanceId);
					if (!instance) {
						console.error(`Instance not found: ${instanceId}`);
						process.exit(2);
					}
				} else {
					instance = await getActiveInstance();
					if (!instance) {
						console.log("No active workflow");
						process.exit(0);
					}
				}

				// Load workflow definition
				const def = await findWorkflowDefinition(instance.workflow_name);
				if (!def) {
					console.error(
						`Workflow definition not found: ${instance.workflow_name}`,
					);
					process.exit(2);
				}

				const currentStep = def.steps.find(
					(s) => s.id === instance?.current_step,
				);
				if (!currentStep) {
					console.error(
						`Current step not found in workflow: ${instance.current_step}`,
					);
					process.exit(2);
				}

				const nextSteps = getNextSteps(def, instance);

				if (options.json) {
					console.log(
						JSON.stringify(
							{
								instance_id: instance.id,
								workflow: instance.workflow_name,
								current_step: {
									id: currentStep.id,
									name: currentStep.name,
									description: currentStep.description,
									outputs: currentStep.outputs,
								},
								state: instance.state,
								available_transitions: nextSteps,
							},
							null,
							2,
						),
					);
				} else {
					console.log(`Current: ${currentStep.id}`);
					console.log("");

					console.log("## Instructions");
					if (currentStep.description) {
						console.log(currentStep.description.trim());
					} else {
						console.log("(no instructions)");
					}
					console.log("");

					// Show expected outputs
					const outputs = currentStep.outputs ?? [];
					if (outputs.length > 0) {
						console.log("## Expected Outputs");
						for (const output of outputs) {
							console.log(`- ${output}`);
						}
						console.log("");
					}

					// Show available transitions
					if (nextSteps.length > 0) {
						console.log("## Available Transitions");
						for (const ns of nextSteps) {
							const statusIcon = ns.condition_met ? "\u2713" : "\u25cb";
							const condText = ns.is_default
								? "(default)"
								: `(${ns.condition})`;
							const metText = ns.condition_met ? "conditions met" : "not met";
							console.log(
								statusIcon +
									" " +
									ns.step_id +
									" " +
									condText +
									" - " +
									metText,
							);
						}
					} else if (isTerminalStep(def, instance.current_step)) {
						console.log(
							"This is a terminal step. Workflow will complete when done.",
						);
					}
				}
			},
		);

	// ============================================
	// step done [--set key=value]... [--to step-id]
	// ============================================
	step
		.command("done [instance-id]")
		.description("Complete current step and advance workflow")
		.option("--json", "Output as JSON")
		.option("--to <step-id>", "Force transition to specific step")
		.option(
			"--set <key=value>",
			"Set state value",
			(val, prev: string[]) => {
				prev.push(val);
				return prev;
			},
			[],
		)
		.action(
			async (
				instanceId: string | undefined,
				options: { json?: boolean; to?: string; set: string[] },
			) => {
				// Load instance
				let instance: WorkflowInstance | null;

				if (instanceId) {
					instance = await loadInstance(instanceId);
					if (!instance) {
						console.error(`Instance not found: ${instanceId}`);
						process.exit(2);
					}
				} else {
					instance = await getActiveInstance();
					if (!instance) {
						console.error("No active workflow");
						process.exit(2);
					}
				}

				// Load workflow definition
				const def = await findWorkflowDefinition(instance.workflow_name);
				if (!def) {
					console.error(
						`Workflow definition not found: ${instance.workflow_name}`,
					);
					process.exit(2);
				}

				const oldStep = instance.current_step;

				// Apply state updates from --set flags
				const stateUpdates: Record<string, unknown> = {};
				for (const setArg of options.set) {
					const eqIdx = setArg.indexOf("=");
					if (eqIdx === -1) {
						console.error("Invalid --set format. Use: --set key=value");
						process.exit(1);
					}
					const key = setArg.slice(0, eqIdx);
					const valueStr = setArg.slice(eqIdx + 1);
					stateUpdates[key] = parseStateValue(valueStr);
				}

				// Update instance state
				if (Object.keys(stateUpdates).length > 0) {
					instance = {
						...instance,
						state: { ...instance.state, ...stateUpdates },
						updated_at: new Date().toISOString(),
					};
				}

				// Determine next step
				let nextStepId: string | null;

				if (options.to) {
					// Validate that --to is a valid edge
					const currentStep = def.steps.find(
						(s) => s.id === instance?.current_step,
					);
					const validTargets = currentStep?.next.map((e) => e.target) ?? [];
					if (!validTargets.includes(options.to)) {
						console.error(
							"Invalid transition: " +
								options.to +
								" is not reachable from " +
								instance.current_step,
						);
						console.error(`Valid targets: ${validTargets.join(", ")}`);
						process.exit(1);
					}
					nextStepId = options.to;
				} else {
					nextStepId = selectNextStep(def, instance);
				}

				// Check if we're in a terminal step
				const isTerminal = isTerminalStep(def, instance.current_step);

				if (nextStepId === null && !isTerminal) {
					console.error(
						"No valid transition from current step with current state",
					);
					console.error(
						`Current state: ${JSON.stringify(instance.state, null, 2)}`,
					);
					process.exit(1);
				}

				// Advance to next step (if not terminal)
				if (nextStepId) {
					instance = advanceToStep(instance, nextStepId);
				}

				// Save instance
				await saveInstance(instance);

				// Log event
				logEvent({
					event: "step_completed",
					instance: instance.id,
					workflow: instance.workflow_name,
					from: oldStep,
					to: nextStepId ?? "(terminal)",
					outputs: Object.keys(stateUpdates).join(", ") || "(none)",
				});

				// Output
				if (options.json) {
					console.log(
						JSON.stringify(
							{
								instance_id: instance.id,
								previous_step: oldStep,
								current_step: instance.current_step,
								state_updates: stateUpdates,
								state: instance.state,
								is_terminal: isTerminal && !nextStepId,
							},
							null,
							2,
						),
					);
				} else {
					console.log(`Step completed: ${oldStep}`);
					if (Object.keys(stateUpdates).length > 0) {
						console.log(
							`Outputs recorded: ${Object.keys(stateUpdates).join(", ")}`,
						);
					}
					if (nextStepId) {
						console.log(`Advanced to: ${nextStepId}`);
						console.log("");
						console.log("Next: tiller step next");
					} else if (isTerminal) {
						console.log("Workflow completed!");
					}
				}
			},
		);
}

/**
 * Parse a state value from command line.
 * Handles booleans, numbers, JSON arrays/objects, and strings.
 */
function parseStateValue(str: string): unknown {
	if (str === "true") return true;
	if (str === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(str)) return parseFloat(str);

	// Try to parse as JSON (for arrays and objects)
	if (str.startsWith("[") || str.startsWith("{") || str.startsWith('"')) {
		try {
			return JSON.parse(str);
		} catch {
			// Fall through to string
		}
	}

	return str;
}
