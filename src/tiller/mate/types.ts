export interface Mate {
	name: string;
	state: "available" | "claimed" | "sailing";
	assignedPlan: string | null; // plan ref like "06.6-04"
	claimedBy: number | null; // PID of claiming process
	claimedBySession: string | null; // Claude session ID (e.g., "48540d5f-5d12-463b-8a82-68cd7d2df560")
	claimedAt: string | null; // ISO timestamp
	createdAt: string;
	updatedAt: string;
}

export interface MateRegistry {
	mates: Record<string, Mate>;
	version: number;
}

export const MATE_ENV = {
	TILLER_MATE: "TILLER_MATE", // current claimed mate name
	TILLER_SESSION: "TILLER_SESSION", // Claude session ID for auto-discovery
	BD_ACTOR: "BD_ACTOR", // for beads integration
} as const;
