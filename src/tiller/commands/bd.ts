/**
 * Tiller BD integration - helpers for beads workflow
 *
 * Hook handlers moved to: tiller hook bd-on-create
 */

import type { Command } from "commander";

export function registerBdCommand(program: Command): void {
	const bd = program.command("bd").description("Beads integration commands");

	// Placeholder - future bd subcommands go here
	// e.g., tiller bd sync, tiller bd link, etc.
	bd.command("help")
		.description("Show bd subcommands")
		.action(() => {
			console.log("Beads integration:");
			console.log("  Hook handler moved to: tiller hook bd-on-create");
			console.log("");
			console.log("Future commands:");
			console.log("  tiller bd sync   - Sync beads with plans");
			console.log("  tiller bd link   - Link bead to plan");
		});
}
