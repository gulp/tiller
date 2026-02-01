/**
 * Event-sourced verification executor (08-03-PLAN)
 *
 * Executes verification checks with deterministic, non-interactive behavior.
 * All results are appended as events to the track's verification log.
 */

import { spawn } from "node:child_process";
import type {
	VerificationCheckDef,
	VerificationCheckExecutedEvent,
} from "../types/index.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_OUTPUT_LINES = 50;
const MAX_OUTPUT_BYTES = 4096;

/**
 * Truncate output to min(50 lines, 4KB) with "(truncated)" marker.
 */
export function truncateOutput(output: string): string {
	// First, limit to 50 lines
	const lines = output.split("\n");
	let result: string;
	let truncatedByLines = false;

	if (lines.length > MAX_OUTPUT_LINES) {
		result = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
		truncatedByLines = true;
	} else {
		result = output;
	}

	// Then, limit to 4KB
	let truncatedByBytes = false;
	if (Buffer.byteLength(result, "utf-8") > MAX_OUTPUT_BYTES) {
		// Find safe truncation point (don't cut in middle of UTF-8 char)
		let bytes = 0;
		let i = 0;
		for (i = 0; i < result.length; i++) {
			const charBytes = Buffer.byteLength(result[i], "utf-8");
			if (bytes + charBytes > MAX_OUTPUT_BYTES - 20) break; // Leave room for marker
			bytes += charBytes;
		}
		result = result.slice(0, i);
		truncatedByBytes = true;
	}

	if (truncatedByLines || truncatedByBytes) {
		result += "\n(truncated)";
	}

	return result;
}

/**
 * Execute a single command check and return an event.
 *
 * Deterministic behavior:
 * - Fixed timeout per check (default 120s, or check-specific override)
 * - Status: pass (exit 0), fail (exit != 0), error (timeout/exec fail)
 * - Combined stdout+stderr, truncated
 */
export function executeCheck(
	checkDef: VerificationCheckDef,
): Promise<VerificationCheckExecutedEvent> {
	return new Promise((resolve) => {
		const timeout = (checkDef.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
		const cmd = checkDef.cmd!;

		let stdout = "";
		let stderr = "";
		let killed = false;
		let exitCode: number | null = null;

		// Spawn with shell to handle complex commands
		const proc = spawn(cmd, [], {
			shell: true,
			timeout,
			cwd: process.cwd(),
		});

		// Collect output
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Set up timeout kill
		const killTimer = setTimeout(() => {
			killed = true;
			proc.kill("SIGKILL");
		}, timeout);

		proc.on("close", (code, signal) => {
			clearTimeout(killTimer);
			exitCode = code;

			const combinedOutput = stdout + stderr;
			const outputTail = truncateOutput(combinedOutput.trim());

			let status: "pass" | "fail" | "error";
			let finalOutput = outputTail;

			if (killed || signal === "SIGKILL") {
				status = "error";
				finalOutput = `(timeout after ${checkDef.timeout ?? DEFAULT_TIMEOUT_SECONDS}s)\n${outputTail}`;
			} else if (code === 0) {
				status = "pass";
			} else {
				status = "fail";
			}

			resolve({
				type: "check_executed",
				name: checkDef.name,
				status,
				exit_code: exitCode,
				output_tail: finalOutput,
				at: new Date().toISOString(),
				by: "agent",
			});
		});

		proc.on("error", (err) => {
			clearTimeout(killTimer);

			resolve({
				type: "check_executed",
				name: checkDef.name,
				status: "error",
				exit_code: null,
				output_tail: truncateOutput(`(exec error: ${err.message})`),
				at: new Date().toISOString(),
				by: "agent",
			});
		});
	});
}

/**
 * Execute all cmd checks sequentially in PLAN order.
 * Returns array of check_executed events.
 */
export async function executeAllChecks(
	checkDefs: VerificationCheckDef[],
	onProgress?: (name: string, index: number, total: number) => void,
): Promise<VerificationCheckExecutedEvent[]> {
	const events: VerificationCheckExecutedEvent[] = [];
	const cmdChecks = checkDefs.filter((c) => c.cmd);

	for (let i = 0; i < cmdChecks.length; i++) {
		const check = cmdChecks[i];
		onProgress?.(check.name, i + 1, cmdChecks.length);

		const event = await executeCheck(check);
		events.push(event);
	}

	return events;
}
