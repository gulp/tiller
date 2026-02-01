/**
 * Hook handlers - unified namespace for Claude Code hook callbacks
 *
 * Usage:
 *   tiller hook bd-on-create    # After bd create, prompt triage
 *   tiller hook plan-on-write   # After Write to PLAN.md, remind workflow
 */

import type { Command } from "commander";

declare const Bun: {
	stdin: { text(): Promise<string> };
};

interface HookInput {
	tool_input?: {
		command?: string;
		file_path?: string;
	};
	tool_response?:
		| {
				stdout?: string;
				stderr?: string;
		  }
		| string;
}

async function readStdinAsync(): Promise<string> {
	if (process.stdin.isTTY) return "";
	try {
		return await Bun.stdin.text();
	} catch (e) {
		if (process.env.TILLER_DEBUG) {
			console.error(`[tiller hook] stdin error: ${(e as Error).message}`);
		}
		return "";
	}
}

function formatHookOutput(message: string): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PostToolUse",
			additionalContext: message,
		},
	});
}

export function registerHookCommand(program: Command): void {
	const hook = program
		.command("hook")
		.description("Claude Code hook handlers");

	// PostToolUse[Bash] - prompt triage after bd create
	hook
		.command("bd-on-create")
		.description("PostToolUse[Bash] - prompt triage after bd create")
		.option("--debug", "Output debug info")
		.action(async (opts: { debug?: boolean }) => {
			try {
				const stdin = await readStdinAsync();

				if (opts.debug) {
					console.log(
						formatHookOutput(`DEBUG: stdin=${stdin.substring(0, 500)}`),
					);
					process.exit(0);
				}

				if (!stdin.trim()) process.exit(0);

				const input: HookInput = JSON.parse(stdin);
				const command = input.tool_input?.command ?? "";

				if (!command.includes("bd create") && !command.includes("bd new")) {
					process.exit(0);
				}

				const toolResponse = input.tool_response;
				const responseText =
					typeof toolResponse === "string"
						? toolResponse
						: (toolResponse?.stdout ?? "");

				const beadMatch = responseText.match(/Created issue:\s*(\S+)/i);
				if (beadMatch?.[1]) {
					console.log(
						formatHookOutput(
							`<system_reminder>New bead ${beadMatch[1]} needs triage. Run \`tiller collect --plan\` or \`tiller collect --todo\`.</system_reminder>`,
						),
					);
				}
				process.exit(0);
			} catch {
				process.exit(0);
			}
		});

	// PostToolUse[Write] - remind to use tiller plan create
	hook
		.command("plan-on-write")
		.description("PostToolUse[Write] - remind workflow for new PLAN.md")
		.action(async () => {
			try {
				const stdin = await readStdinAsync();
				if (!stdin.trim()) process.exit(0);

				const input: HookInput = JSON.parse(stdin);
				const filePath = input.tool_input?.file_path ?? "";

				// Match plans/<initiative>/.../<ref>-PLAN.md
				const planMatch = filePath.match(
					/plans\/([^/]+)\/.*?(\d+(?:\.\d+)?-\d+)-PLAN\.md$/,
				);
				if (!planMatch) {
					process.exit(0);
				}

				const [, initiative, ref] = planMatch;

				console.log(
					formatHookOutput(
						`<system_reminder>**Critical:** Run \`tiller init ${initiative}:${ref}\` NOW to register this plan. Next time use: tiller plan create "objective" --phase <phase> --initiative ${initiative}</system_reminder>`,
					),
				);
				process.exit(0);
			} catch {
				process.exit(0);
			}
		});
}
