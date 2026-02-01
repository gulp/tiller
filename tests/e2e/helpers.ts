/**
 * Test helpers for Tiller CLI E2E tests
 */

import { spawn } from "node:child_process";
import {
	CLI_PATH,
	cleanupTestEnv,
	createMockPlan,
	createMockSummary,
	createMockTrack,
	createTestEnv,
} from "./setup";

// Re-export setup utilities for convenience
export {
	createTestEnv,
	cleanupTestEnv,
	createMockTrack,
	createMockPlan,
	createMockSummary,
};

export interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/**
 * Run the tiller CLI with given arguments
 *
 * @param args - Command line arguments to pass to tiller
 * @param options - Execution options
 * @returns Promise resolving to stdout, stderr, and exit code
 */
export async function runTiller(
	args: string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		timeout?: number;
	} = {},
): Promise<RunResult> {
	const { cwd = process.cwd(), env = process.env, timeout = 10000 } = options;

	return new Promise((resolve, reject) => {
		const proc = spawn("node", [CLI_PATH, ...args], {
			cwd,
			env: { ...env, NO_COLOR: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		const timeoutId = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`Tiller CLI timed out after ${timeout}ms`));
		}, timeout);

		proc.on("close", (exitCode) => {
			clearTimeout(timeoutId);
			resolve({ stdout, stderr, exitCode });
		});

		proc.on("error", (err) => {
			clearTimeout(timeoutId);
			reject(err);
		});
	});
}

/**
 * Helper to assert CLI output contains expected text
 */
export function expectOutput(result: RunResult, expected: string): void {
	const combined = result.stdout + result.stderr;
	if (!combined.includes(expected)) {
		throw new Error(
			`Expected output to contain "${expected}"\nGot:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
}

/**
 * Helper to assert CLI exited with expected code
 */
export function expectExitCode(result: RunResult, expected: number): void {
	if (result.exitCode !== expected) {
		throw new Error(
			`Expected exit code ${expected}, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
}
