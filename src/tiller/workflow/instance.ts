/**
 * Workflow Instance Storage
 *
 * Manages persistence of workflow instances in .tiller/workflows/instances/.
 * Each active workflow execution is stored as a separate JSON file.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "../state/config.js";
import type { WorkflowDefinition, WorkflowInstance } from "./types.js";

// Derived from PATHS (cwd-independent)
const INSTANCES_DIR = PATHS.WORKFLOW_INSTANCES_DIR;

/**
 * Ensure the instance storage directory exists.
 */
function ensureInstancesDir(): void {
	if (!existsSync(INSTANCES_DIR)) {
		mkdirSync(INSTANCES_DIR, { recursive: true });
	}
}

/**
 * Get the file path for an instance.
 */
function getInstancePath(instanceId: string): string {
	return join(INSTANCES_DIR, `${instanceId}.json`);
}

/**
 * Generate a unique instance ID for a workflow.
 *
 * Format: {workflow-name}-{unix-timestamp}
 *
 * @param workflowName - The name of the workflow
 * @returns A unique instance ID
 */
export function generateInstanceId(workflowName: string): string {
	const timestamp = Math.floor(Date.now() / 1000);
	return `${workflowName}-${timestamp}`;
}

/**
 * Create a new workflow instance from a definition.
 *
 * Initializes the instance at the workflow's initial step with empty state,
 * persists it to disk, and returns the created instance.
 *
 * @param def - The workflow definition
 * @returns The newly created and persisted workflow instance
 */
export async function createInstance(
	def: WorkflowDefinition,
): Promise<WorkflowInstance> {
	ensureInstancesDir();

	const now = new Date().toISOString();
	const instanceId = generateInstanceId(def.name);

	const instance: WorkflowInstance = {
		id: instanceId,
		workflow_name: def.name,
		current_step: def.initial_step,
		state: {},
		history: [def.initial_step],
		started_at: now,
		updated_at: now,
	};

	await saveInstance(instance);
	return instance;
}

/**
 * Load a workflow instance by ID.
 *
 * @param instanceId - The instance ID to load
 * @returns The workflow instance, or null if not found
 */
export async function loadInstance(
	instanceId: string,
): Promise<WorkflowInstance | null> {
	const filePath = getInstancePath(instanceId);

	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = await readFile(filePath, "utf-8");
		return JSON.parse(content) as WorkflowInstance;
	} catch {
		return null;
	}
}

/**
 * Save a workflow instance to disk.
 *
 * Updates the `updated_at` timestamp before saving.
 *
 * @param instance - The workflow instance to save
 */
export async function saveInstance(instance: WorkflowInstance): Promise<void> {
	ensureInstancesDir();

	const updatedInstance: WorkflowInstance = {
		...instance,
		updated_at: new Date().toISOString(),
	};

	const filePath = getInstancePath(instance.id);
	await writeFile(filePath, JSON.stringify(updatedInstance, null, 2));
}

/**
 * List all workflow instances.
 *
 * @returns Array of instances sorted by updated_at descending (most recent first)
 */
export async function listInstances(): Promise<WorkflowInstance[]> {
	ensureInstancesDir();

	if (!existsSync(INSTANCES_DIR)) {
		return [];
	}

	try {
		const files = await readdir(INSTANCES_DIR);
		const jsonFiles = files.filter((f) => f.endsWith(".json"));

		const instances: WorkflowInstance[] = [];

		for (const file of jsonFiles) {
			const filePath = join(INSTANCES_DIR, file);
			try {
				const content = await readFile(filePath, "utf-8");
				const instance = JSON.parse(content) as WorkflowInstance;
				instances.push(instance);
			} catch {
				// Skip invalid files
			}
		}

		// Sort by updated_at descending
		instances.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

		return instances;
	} catch {
		return [];
	}
}

/**
 * Get the most recently active workflow instance.
 *
 * An "active" instance is one that hasn't reached a terminal step.
 * Since we don't know terminal steps here (would need the workflow definition),
 * this returns the most recently updated instance.
 *
 * @returns The most recently updated instance, or null if none exist
 */
export async function getActiveInstance(): Promise<WorkflowInstance | null> {
	const instances = await listInstances();

	if (instances.length === 0) {
		return null;
	}

	// Return most recently updated (already sorted descending)
	return instances[0];
}

/**
 * Delete a workflow instance.
 *
 * @param instanceId - The instance ID to delete
 */
export async function deleteInstance(instanceId: string): Promise<void> {
	const filePath = getInstancePath(instanceId);

	if (existsSync(filePath)) {
		await unlink(filePath);
	}
}

/**
 * Path constants for external use.
 */
export const INSTANCE_PATHS = {
	TILLER_DIR: PATHS.TILLER_DIR,
	WORKFLOWS_DIR: PATHS.WORKFLOWS_DIR,
	INSTANCES_DIR,
} as const;
