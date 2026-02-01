/**
 * Deterministic Hand Name Generator
 *
 * Generates stable, human-friendly names from track and run IDs.
 * 32 × 32 = 1,024 unique combinations, no runtime state needed.
 */

/**
 * Pool A — Neutral given names (32)
 * Cross-gender, 4-5 letters, common, intentionally boring
 */
const FIRST_NAMES = [
	"alex",
	"sam",
	"jules",
	"chris",
	"casey",
	"jamie",
	"morgan",
	"riley",
	"quinn",
	"taylor",
	"devon",
	"rowan",
	"avery",
	"blake",
	"camer",
	"ellis",
	"finch",
	"harper",
	"jordan",
	"kendal",
	"logan",
	"parker",
	"reese",
	"river",
	"sage",
	"sky",
	"spencer",
	"tegan",
	"tyler",
	"valen",
	"wren",
	"yael",
] as const;

/**
 * Pool B — Neutral surnames/handles (32)
 * No gender signal, mostly physical/spatial/abstract
 */
const LAST_NAMES = [
	"reed",
	"lane",
	"gray",
	"west",
	"moor",
	"hall",
	"ford",
	"cole",
	"ross",
	"knox",
	"hart",
	"stone",
	"field",
	"brook",
	"ridge",
	"shore",
	"cliff",
	"plain",
	"cross",
	"march",
	"north",
	"south",
	"delta",
	"plate",
	"cairn",
	"glass",
	"ember",
	"flare",
	"slate",
	"grain",
	"trace",
	"vein",
] as const;

/**
 * String hash with good distribution (FNV-1a variant)
 * Produces consistent 32-bit integer from any string
 */
function hash(str: string): number {
	let h = 2166136261; // FNV offset basis
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619); // FNV prime
	}
	return h >>> 0; // Ensure unsigned
}

/**
 * Secondary hash for better distribution in single-seed case
 */
function hash2(str: string): number {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = str.charCodeAt(i) + ((h << 6) + (h << 16) - h);
	}
	return h >>> 0;
}

/**
 * Generate deterministic hand name from run and session IDs
 *
 * @param runId - Identifies the work run/workflow (determines first name)
 * @param sessionId - Identifies the specific session (determines last name)
 * @returns Name in format "first-last" (e.g., "alex-reed")
 *
 * @example
 * handName("phase-02", "session-abc123")  // → "morgan-stone"
 * handName("phase-02", "session-xyz789")  // → "morgan-flare"
 * handName("phase-03", "session-abc123")  // → "riley-stone"
 */
export function handName(runId: string, sessionId: string): string {
	const first = FIRST_NAMES[hash(runId) % 32];
	const last = LAST_NAMES[hash(sessionId) % 32];
	return `${first}-${last}`;
}

/**
 * Generate hand name from single seed (for simple cases)
 * Uses two independent hashes for better distribution
 *
 * @param seed - Any string identifier
 * @returns Name in format "first-last"
 */
export function handNameFromSeed(seed: string): string {
	const first = FIRST_NAMES[hash(seed) % 32];
	const last = LAST_NAMES[hash2(seed) % 32];
	return `${first}-${last}`;
}

/**
 * Generate hand name from timestamp + random (for anonymous hands)
 */
export function randomHandName(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return handNameFromSeed(`${timestamp}-${random}`);
}

// Export pools for testing/inspection
export { FIRST_NAMES, LAST_NAMES, hash };
