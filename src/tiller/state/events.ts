/**
 * Event logging for audit trail
 *
 * Append-only JSONL log for track events
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TillerEvent } from "../types/index.js";
import { ensureTillerDir } from "./config.js";
import { CORE_PATHS } from "./paths.js";

// Use CORE_PATHS directly to avoid circular dependency (config→migration→events→config)
const EVENTS_FILE = join(CORE_PATHS.TILLER_DIR, "events.jsonl");

/**
 * Append event to log
 */
export function logEvent(event: Omit<TillerEvent, "ts">): void {
	ensureTillerDir();

	const fullEvent = {
		...event,
		ts: new Date().toISOString(),
	} as TillerEvent;

	const line = `${JSON.stringify(fullEvent)}\n`;
	appendFileSync(EVENTS_FILE, line);
}

/**
 * Read recent events (last N)
 */
export function readEvents(limit?: number): TillerEvent[] {
	if (!existsSync(EVENTS_FILE)) {
		return [];
	}

	try {
		const content = readFileSync(EVENTS_FILE, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		const events = lines.map((line) => JSON.parse(line) as TillerEvent);

		if (limit) {
			return events.slice(-limit);
		}
		return events;
	} catch {
		return [];
	}
}

/**
 * Get events for a specific run
 */
export function getEventsForRun(
	runId: string,
	limit?: number,
): TillerEvent[] {
	const allEvents = readEvents();
	const runEvents = allEvents.filter((e) => e.track === runId);

	if (limit) {
		return runEvents.slice(-limit);
	}
	return runEvents;
}

/**
 * Get events file path
 */
export function getEventsPath(): string {
	return EVENTS_FILE;
}
