/**
 * Verification module barrel export
 */

// Check parsing & execution (legacy)
export {
	getOverallStatus,
	hasVerificationSection,
	type ParsedCheck,
	parseVerificationSection,
	parseVerificationSectionFull,
	runVerificationChecks,
} from "./checks.js";

// Fix plan generation
export {
	extractUATIssues,
	type FixPlan,
	type FixTask,
	generateFixPlanContent,
	generateFixTasks,
	getFixPlanPath,
	type UATIssue,
} from "./fix.js";

// Format parsing
export {
	hasYamlVerificationSection,
	type ParseResult,
	parseVerification,
	parseVerificationYaml,
	type VerificationFormat,
} from "./parser.js";

// Deterministic execution
export {
	executeAllChecks,
	executeCheck,
	truncateOutput,
} from "./executor.js";

// UAT generation
export {
	extractDeliverables,
	formatChecklist,
	generateChecklist,
	getUATSummary,
	type UATCheckItem,
	type UATSession,
} from "./uat.js";

// Run resolution
export { getRunForVerify, isPhaseRef } from "./run-resolver.js";

// Summary utilities
export {
	extractFilesModified,
	findAutopassSummaryPath,
	findFinalizedSummaryPath,
	findSummaryPath,
	type FinalizeSummaryOptions,
	finalizeSummary,
} from "./summary.js";

// Result recording (state transitions)
export {
	type ManualCheckResult,
	type ManualChecksPendingError,
	type RecordError,
	type RecordFailResult,
	type RecordManualCheckOptions,
	type RecordPassOptions,
	type RecordPassResult,
	recordFailVerification,
	recordManualCheckResult,
	recordPassVerification,
	skipVerification,
} from "./recorder.js";

// Phase health checks
export {
	formatPhaseHealthReport,
	getPhaseHealthReport,
	type PhaseHealthCheck,
	type PhaseHealthReport,
} from "./phase-health.js";

// Checkbox updater
export { updatePlanCheckboxes } from "./updater.js";
