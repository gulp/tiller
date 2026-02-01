/**
 * Tiller workflow commands
 *
 * Commands for managing workflow instances:
 * - workflow start: Start a new workflow instance
 * - workflow status: Query current workflow position
 * - workflow resume: Resume workflow with full context
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { PATHS } from "../state/config.js";
import { logEvent } from "../state/events.js";
import {
	createCliContext,
	createInstance,
	executeWorkflow,
	getActiveInstance,
	loadInstance,
	loadWorkflowFile,
	serializeWorkflowState,
	type WorkflowDefinition,
	type WorkflowInstance,
} from "../workflow/index.js";

// Workflow definition locations (derived from PATHS)
const TILLER_WORKFLOWS_DIR = PATHS.WORKFLOWS_DIR;
const BUILTIN_WORKFLOWS_DIR = join(PATHS.PROJECT_ROOT, "src/tiller/workflows");

/**
 * Find a workflow definition file by name.
 * Checks project-specific .tiller/workflows/ first, then built-in.
 */
async function findWorkflowDefinition(
	name: string,
): Promise<{ def: WorkflowDefinition; path: string } | null> {
	// Check project-specific first
	const projectPath = join(TILLER_WORKFLOWS_DIR, `${name}.toml`);
	if (existsSync(projectPath)) {
		try {
			const def = await loadWorkflowFile(projectPath);
			return { def, path: projectPath };
		} catch {
			// Fall through to try built-in
		}
	}

	// Check built-in workflows
	const builtinPath = join(BUILTIN_WORKFLOWS_DIR, `${name}.toml`);
	if (existsSync(builtinPath)) {
		try {
			const def = await loadWorkflowFile(builtinPath);
			return { def, path: builtinPath };
		} catch {
			return null;
		}
	}

	return null;
}

/**
 * List available workflows.
 */
function listAvailableWorkflows(): string[] {
	const workflows: string[] = [];

	// Could scan directories for .toml files
	// For now, return known workflow names
	const knownWorkflows = ["new-project", "plan-phase", "execute-plan"];

	for (const name of knownWorkflows) {
		const projectPath = join(TILLER_WORKFLOWS_DIR, `${name}.toml`);
		const builtinPath = join(BUILTIN_WORKFLOWS_DIR, `${name}.toml`);
		if (existsSync(projectPath) || existsSync(builtinPath)) {
			workflows.push(name);
		}
	}

	return workflows;
}

export function registerWorkflowCommands(program: Command): void {
	const workflow = program
		.command("workflow")
		.description("Manage workflow instances");

	// ============================================
	// workflow list
	// ============================================
	workflow
		.command("list")
		.description("List available workflow definitions")
		.option("--json", "Output as JSON")
		.action((options: { json?: boolean }) => {
			const workflows = listAvailableWorkflows();

			if (options.json) {
				console.log(JSON.stringify({ workflows }, null, 2));
			} else {
				if (workflows.length === 0) {
					console.log("No workflows available");
				} else {
					console.log("Available workflows:");
					for (const name of workflows) {
						console.log(`  ${name}`);
					}
				}
			}
		});

	// ============================================
	// workflow start <workflow-name>
	// ============================================
	workflow
		.command("start <workflow-name>")
		.description("Start a new workflow instance")
		.option("--json", "Output as JSON")
		.option(
			"--interactive",
			"Run workflow in interactive mode (auto-advances steps)",
		)
		.action(
			async (
				workflowName: string,
				options: { json?: boolean; interactive?: boolean },
			) => {
				// Find workflow definition
				const found = await findWorkflowDefinition(workflowName);

				if (!found) {
					console.error(`Workflow not found: ${workflowName}`);
					const available = listAvailableWorkflows();
					if (available.length > 0) {
						console.error(`Available workflows: ${available.join(", ")}`);
					}
					process.exit(2);
				}

				const { def, path } = found;

				// Create instance
				const instance = await createInstance(def);

				// Log event
				logEvent({
					event: "workflow_started",
					workflow: def.name,
					instance: instance.id,
					plan: path,
				});

				// Interactive mode: run executor
				if (options.interactive) {
					console.log(`Starting interactive workflow: ${def.name}`);
					console.log(`Instance: ${instance.id}`);
					console.log("");

					const ctx = createCliContext();
					const result = await executeWorkflow(def, instance, ctx);

					if (result.success) {
						console.log("");
						console.log(`Workflow completed successfully`);
						console.log(`Steps completed: ${result.stepsCompleted}`);
					} else {
						console.error("");
						console.error(`Workflow failed: ${result.error}`);
						console.error(`Steps completed: ${result.stepsCompleted}`);
						process.exit(1);
					}
					return;
				}

				// Normal mode: just show initial step
				if (options.json) {
					// Find next steps for JSON output
					const currentStep = def.steps.find(
						(s) => s.id === instance.current_step,
					);
					const nextSteps =
						currentStep?.next.map((e) => ({
							step: e.target,
							condition: e.condition,
							label: e.label,
						})) ?? [];

					console.log(
						JSON.stringify(
							{
								instance_id: instance.id,
								workflow: instance.workflow_name,
								current_step: instance.current_step,
								state: instance.state,
								next_steps: nextSteps,
							},
							null,
							2,
						),
					);
				} else {
					console.log(`Started workflow: ${def.name}`);
					console.log(`Instance: ${instance.id}`);
					console.log(`At step: ${instance.current_step}`);

					// Show initial step info
					const initialStep = def.steps.find((s) => s.id === def.initial_step);
					if (initialStep) {
						console.log(`\nStep: ${initialStep.name}`);
						if (initialStep.description) {
							console.log(`\n${initialStep.description.trim()}`);
						}
					}
				}
			},
		);

	// ============================================
	// workflow status [instance-id]
	// ============================================
	workflow
		.command("status [instance-id]")
		.description("Show workflow instance status")
		.option("--json", "Output as JSON")
		.option("--toon", "Output as TOON format for agent context")
		.action(
			async (
				instanceId: string | undefined,
				options: { json?: boolean; toon?: boolean },
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
						console.log("No active workflow");
						process.exit(0);
					}
				}

				// Load workflow definition for next steps calculation
				const found = await findWorkflowDefinition(instance.workflow_name);
				if (!found) {
					console.error(
						`Workflow definition not found: ${instance.workflow_name}`,
					);
					process.exit(2);
				}

				const { def } = found;
				const currentStep = def.steps.find(
					(s) => s.id === instance?.current_step,
				);

				if (options.toon) {
					// TOON format for agent context
					console.log(serializeWorkflowState(def, instance));
				} else if (options.json) {
					const nextSteps =
						currentStep?.next.map((e) => ({
							step: e.target,
							condition: e.condition,
							label: e.label,
						})) ?? [];

					console.log(
						JSON.stringify(
							{
								instance_id: instance.id,
								workflow: instance.workflow_name,
								current_step: instance.current_step,
								step_name: currentStep?.name,
								state: instance.state,
								history: instance.history,
								next_steps: nextSteps,
								started_at: instance.started_at,
								updated_at: instance.updated_at,
							},
							null,
							2,
						),
					);
				} else {
					// Human-readable format
					console.log(`Workflow: ${instance.workflow_name}`);
					console.log(`Instance: ${instance.id}`);
					console.log(`Current step: ${instance.current_step}`);
					if (currentStep) {
						console.log(`Step name: ${currentStep.name}`);
					}
					console.log(`History: ${instance.history.join(" > ")}`);

					// Show state
					const stateEntries = Object.entries(instance.state);
					if (stateEntries.length > 0) {
						console.log("\nState:");
						for (const [key, value] of stateEntries) {
							console.log(`  ${key}: ${JSON.stringify(value)}`);
						}
					}

					// Show next steps
					if (currentStep && currentStep.next.length > 0) {
						console.log("\nNext steps:");
						for (const edge of currentStep.next) {
							const condText = edge.condition
								? `[${edge.condition}]`
								: "[default]";
							const labelText = edge.label ? ` - ${edge.label}` : "";
							console.log(`  ${edge.target} ${condText}${labelText}`);
						}
					}
				}
			},
		);

	// ============================================
	// workflow resume [instance-id]
	// ============================================
	workflow
		.command("resume [instance-id]")
		.description("Resume workflow with full context")
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
						console.error("No workflow to resume");
						process.exit(2);
					}
				}

				// Load workflow definition
				const found = await findWorkflowDefinition(instance.workflow_name);
				if (!found) {
					console.error(
						`Workflow definition not found: ${instance.workflow_name}`,
					);
					process.exit(2);
				}

				const { def } = found;
				const currentStep = def.steps.find(
					(s) => s.id === instance?.current_step,
				);

				if (!currentStep) {
					console.error(`Step not found in workflow: ${instance.current_step}`);
					process.exit(2);
				}

				if (options.json) {
					const nextSteps = currentStep.next.map((e) => ({
						step: e.target,
						condition: e.condition,
						label: e.label,
					}));

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
								history: instance.history,
								next_steps: nextSteps,
							},
							null,
							2,
						),
					);
				} else {
					// Human-readable format for agent context recovery
					console.log(
						"Resuming: " +
							instance.workflow_name +
							" @ " +
							instance.current_step,
					);
					console.log("");

					console.log("## Current Step");
					console.log(`**${currentStep.name}**`);
					if (currentStep.description) {
						console.log(currentStep.description.trim());
					}
					console.log("");

					// Show state
					const stateEntries = Object.entries(instance.state);
					if (stateEntries.length > 0) {
						console.log("## State So Far");
						for (const [key, value] of stateEntries) {
							console.log(`- ${key}: ${JSON.stringify(value)}`);
						}
						console.log("");
					}

					// Show expected outputs
					const outputs = currentStep.outputs ?? [];
					if (outputs.length > 0) {
						console.log("## Expected Outputs");
						for (const output of outputs) {
							console.log(`- ${output}`);
						}
						console.log("");
					}

					// Show next steps
					if (currentStep.next.length > 0) {
						console.log("## Next Steps");
						for (const edge of currentStep.next) {
							const condText = edge.condition
								? `(if ${edge.condition})`
								: "(default)";
							console.log(`- ${edge.target} ${condText}`);
						}
					}
				}
			},
		);
}
