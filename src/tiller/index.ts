#!/usr/bin/env bun
/**
 * Tiller CLI - Multi-session workflow automation for Claude Code
 */

import { Command } from "commander";
import { registerAcceptCommand } from "./commands/accept.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerAssignCommand } from "./commands/assign.js";
import { registerBdCommand } from "./commands/bd.js";
import { registerCheckCommands } from "./commands/check.js";
import { registerClaimingCommands } from "./commands/claiming.js";
import { registerCodebaseCommands } from "./commands/codebase.js";
import { registerCollectCommand } from "./commands/collect.js";
import { registerDebugCommands } from "./commands/debug.js";
import { registerFocusCommand } from "./commands/focus.js";
import { registerMilestoneCommands } from "./commands/milestone.js";
import { registerConstitutionalCommands } from "./commands/constitutional.js";
import { registerDoctorCommands } from "./commands/doctor.js";
import { registerRemediateCommand } from "./commands/remediate.js";
import { registerHandCommands } from "./commands/hand.js";
import { registerHookCommand } from "./commands/hook.js";
import { registerInitCommand } from "./commands/init.js";
import { registerInitiativeCommands } from "./commands/initiative.js";
import { registerLifecycleCommands } from "./commands/lifecycle.js";
import { registerMateCommands } from "./commands/mate.js";
import {
	registerMigrateCommand,
	registerMigrateRollbackCommand,
} from "./commands/migrate.js";
import { registerPatrolCommand } from "./commands/patrol.js";
import { registerPlanCommands } from "./commands/plan.js";
import { registerPreflightCommand } from "./commands/preflight.js";
import { registerPrimeCommand } from "./commands/prime.js";
import { registerPruneCommand } from "./commands/prune.js";
import { registerQueryCommands } from "./commands/query.js";
import { registerReadyCommand } from "./commands/ready.js";
import { registerRepairCommand } from "./commands/repair.js";
import { registerRoadmapCommands } from "./commands/roadmap.js";
import { registerRunCommands } from "./commands/run.js";
import { registerSailCommand } from "./commands/sail.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStepCommands } from "./commands/step.js";
import { registerSummaryCommands } from "./commands/summary.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerTodoCommands } from "./commands/todo.js";
import { registerUATCommand } from "./commands/uat.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { registerWorkflowCommands } from "./commands/workflow.js";
import { registerWorktreeCommand } from "./commands/worktree.js";
import { configureAXErrors } from "./ax/error-hints.js";

const program = new Command();

program
	.name("tiller")
	.description("Multi-session workflow automation for Claude Code")
	.version("0.1.0")
	.option("-y, --yes", "Skip confirmation prompts (agent-friendly)");

registerInitCommand(program);
registerLifecycleCommands(program);
registerQueryCommands(program);
registerReadyCommand(program);
registerWorkflowCommands(program);
registerStepCommands(program);
registerHandCommands(program);
registerPatrolCommand(program);
registerClaimingCommands(program);
registerAgentCommands(program);
registerVerifyCommand(program);
registerUATCommand(program);
registerRemediateCommand(program);
registerSummaryCommands(program);
registerDoctorCommands(program);
registerRoadmapCommands(program);
registerInitiativeCommands(program);
registerFocusCommand(program);
registerConstitutionalCommands(program);
registerMigrateCommand(program);
registerMigrateRollbackCommand(program);
registerTodoCommands(program);
registerPrimeCommand(program);
registerPlanCommands(program);
registerMateCommands(program);
registerAcceptCommand(program);
registerAssignCommand(program);
registerSailCommand(program);
registerSetupCommand(program);
registerRepairCommand(program);
registerSyncCommand(program);
registerWorktreeCommand(program);
registerPruneCommand(program);
registerCollectCommand(program);
registerBdCommand(program);
registerHookCommand(program);
registerPreflightCommand(program);
registerRunCommands(program);
registerCheckCommands(program);
registerDebugCommands(program);
registerMilestoneCommands(program);
registerCodebaseCommands(program);

// Configure AX error hints before parsing
configureAXErrors(program);

program.parse();
