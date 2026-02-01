/**
 * TOON serializer for planning context
 * Structures data for optimal TOON encoding with uniform arrays
 */

import { DELIMITERS, encode } from "@toon-format/toon";
import type { PlanningContext } from "./gatherer.js";

/**
 * Serialize planning context to TOON format
 * Structures data for optimal encoding with uniform arrays
 */
export function serializeContext(ctx: PlanningContext): string {
	// Structure data for optimal TOON encoding:
	// - Uniform arrays for summaries, files, phases
	// - Flat key-values for metadata
	const data = {
		meta: {
			initiative: ctx.initiative,
			phase: ctx.phase,
			project_name: ctx.project.name,
			core_value: ctx.project.coreValue,
		},
		current_phase: ctx.roadmap.currentPhase,
		phases: ctx.roadmap.phases, // uniform array - TOON excels here
		prior_summaries: ctx.priorSummaries, // uniform array
		source_files: ctx.sourceFiles, // uniform array
		state_proposed: ctx.state.proposed,
		state_authoritative: ctx.state.authoritative,
	};

	return encode(data, {
		indent: 2,
		delimiter: DELIMITERS.tab, // tab tokenizes better than comma
		keyFolding: "safe", // collapse nested wrapper chains
	});
}
