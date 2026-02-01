#!/usr/bin/env bun
/**
 * Ahoy CLI - Intent shaping CLI for multi-initiative planning
 */

import { Command } from "commander";
import { registerDiscussCommand } from "./commands/discuss.js";
import { registerDraftCommand } from "./commands/draft.js";
import { registerHandoffCommand } from "./commands/handoff.js";
import { registerListCommand } from "./commands/list.js";
import { registerLockCommand } from "./commands/lock.js";
import { registerNumberCommand } from "./commands/number.js";
import { registerPrimeCommand, registerTopLevelPrimeCommand } from "./commands/prime.js";
import { registerResearchCommand } from "./commands/research.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerScopeCommand } from "./commands/scope.js";
import { registerShowCommand } from "./commands/show.js";
import { registerStatusCommand } from "./commands/status.js";

const program = new Command();

program
	.name("ahoy")
	.description("Intent shaping CLI for multi-initiative planning")
	.version("0.1.0");

// Phase planning commands (subcommand group)
const phaseCmd = program
	.command("phase")
	.description("Phase planning commands");

// Register phase subcommands
registerPrimeCommand(phaseCmd);

// Top-level prime command (session primer)
registerTopLevelPrimeCommand(program);

// Draft lifecycle commands (ADR-0005)
registerDraftCommand(program);
registerShowCommand(program);
registerNumberCommand(program);
registerLockCommand(program);

// Status command
registerStatusCommand(program);

// Discuss command (agent-first)
registerDiscussCommand(program);

// Research command (agent-first)
registerResearchCommand(program);

// Review command (agent-first)
registerReviewCommand(program);

// Scope command (agent-first)
registerScopeCommand(program);

// Handoff command
registerHandoffCommand(program);

// List command
registerListCommand(program);

// Export for command registration
export { program, phaseCmd };

program.parse();
