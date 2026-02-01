/**
 * Hands Module - Multi-agent worker coordination
 *
 * Tiller spawns "hands" to execute tasks in parallel.
 * Each hand self-organizes to claim unblocked work from beads.
 */

// Claiming
export {
	claimTask,
	closeTask,
	findReadyTasks,
	heartbeat,
	updateHandState,
} from "./claim.js";
// File management
export type { HandFile, HandFileState } from "./file.js";
export {
	ensureHandsDir,
	HANDS_DIR,
	killHand,
	listHands,
	loadHand,
	lockHand,
	reserveHand,
	unlockHand,
	updateHandFileState,
} from "./file.js";
// Name generation
export {
	FIRST_NAMES,
	handName,
	handNameFromSeed,
	hash,
	LAST_NAMES,
	randomHandName,
} from "./names.js";
// Registration
export {
	createHand,
	generateHandName,
	getOrCreateHandName,
	recordCompletion,
	setCurrentTask,
	setHandState,
	shutdownHand,
} from "./register.js";
// Types
export type {
	ClaimResult,
	Hand,
	HandState,
	SpawnOptions,
	TaskFilter,
	WorkLoopConfig,
} from "./types.js";
export { HAND_ENV } from "./types.js";
