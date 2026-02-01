/**
 * Focus management commands - Session-scoped initiative focus
 *
 * Prevents cross-session pollution by requiring explicit focus.
 * `tiller prime` clears focus, `tiller focus <initiative>` sets it.
 */

import type { Command } from "commander";
import {
	getWorkingInitiative,
	hasExplicitFocus,
	setWorkingInitiative,
} from "../state/initiative.js";
import { listInitiatives } from "./initiative.js";
import { outputTOON } from "../types/toon.js";

export function registerFocusCommand(program: Command): void {
	// tiller focus [initiative]
	program
		.command("focus [initiative]")
		.description("Set or show session-scoped initiative focus")
		.action((initiative?: string) => {
			if (initiative) {
				// Validate initiative exists
				const initiatives = listInitiatives();
				if (!initiatives.includes(initiative)) {
					outputTOON({
						focus_error: {
							error: "initiative_not_found",
							requested: initiative,
							available_initiatives: initiatives,
						},
					}, {
						agent_hint: `Initiative "${initiative}" not found. Available: ${initiatives.join(", ") || "(none)"}`,
					});
					process.exit(1);
				}

				// Set focus
				const previous = getWorkingInitiative();
				setWorkingInitiative(initiative);

				outputTOON({
					focus: {
						initiative,
						previous: previous ?? null,
						action: "set",
					},
				}, {
					agent_hint: `Focused on ${initiative}. Plan commands will target this initiative. Use --initiative for one-offs.`,
				});
			} else {
				// Show current focus - only show explicit focus, not default_initiative fallback
				const hasFocus = hasExplicitFocus();
				const current = hasFocus ? getWorkingInitiative() : null;
				outputTOON({
					focus: {
						initiative: current,
						action: "show",
					},
				}, {
					agent_hint: current
						? `Currently focused on ${current}.`
						: "No initiative focused. Run `tiller focus <name>` or use --initiative flag.",
				});
			}
		});

	// tiller unfocus
	program
		.command("unfocus")
		.description("Clear session-scoped initiative focus")
		.action(() => {
			const previous = getWorkingInitiative();
			setWorkingInitiative(null);

			outputTOON({
				focus: {
					initiative: null,
					previous: previous ?? null,
					action: "clear",
				},
			}, {
				agent_hint: "Focus cleared. Use `tiller focus <name>` or --initiative flag for plan commands.",
			});
		});
}
