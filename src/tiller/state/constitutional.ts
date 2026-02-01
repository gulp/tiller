/**
 * Constitutional knowledge injection
 *
 * Reads markdown files from .tiller/constitutional/ and outputs
 * them when agent begins work (via tiller activate).
 *
 * User controls content by adding/removing files.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CORE_PATHS } from "./paths.js";

// Derive from centralized CORE_PATHS
const CONSTITUTIONAL_DIR = join(CORE_PATHS.TILLER_DIR, "constitutional");

export function getConstitutionalDir(): string {
	return CONSTITUTIONAL_DIR;
}

export function ensureConstitutionalDir(): void {
	if (!existsSync(CONSTITUTIONAL_DIR)) {
		mkdirSync(CONSTITUTIONAL_DIR, { recursive: true });
	}
}

export function readConstitutionalFiles(): string[] {
	if (!existsSync(CONSTITUTIONAL_DIR)) {
		return [];
	}

	const files = readdirSync(CONSTITUTIONAL_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort(); // Alphabetical order for predictability

	return files.map((f) => {
		const content = readFileSync(join(CONSTITUTIONAL_DIR, f), "utf-8");
		return content.trim();
	});
}

export function outputConstitutional(): void {
	const contents = readConstitutionalFiles();

	if (contents.length === 0) {
		return; // No constitutional files, skip silently
	}

	console.log("═══════════════════════════════════════════════════════════");
	console.log("⚠ CONSTITUTIONAL REMINDERS");
	console.log("═══════════════════════════════════════════════════════════");
	console.log("");

	for (const content of contents) {
		console.log(content);
		console.log("");
		console.log("---");
		console.log("");
	}

	console.log("═══════════════════════════════════════════════════════════");
	console.log("");
}

/**
 * Initialize default constitutional files if directory is empty
 */
export function initDefaultConstitutional(): void {
	ensureConstitutionalDir();

	const testIntegrityPath = join(CONSTITUTIONAL_DIR, "01-test-integrity.md");
	if (!existsSync(testIntegrityPath)) {
		writeFileSync(
			testIntegrityPath,
			`<test_integrity>
Tests verify behavior. If tests fail:
1. Code is broken → fix the code
2. Test setup is broken → fix the setup
3. Test is wrong → fix the test

NEVER:
- Remove tests because they're "too complex"
- "Simplify" tests by removing assertions that fail
- Skip tests that require state persistence (that IS the feature)

If a test is hard to make pass, that's signal—not noise.
</test_integrity>
`,
		);
	}

	const verificationPath = join(CONSTITUTIONAL_DIR, "02-verification.md");
	if (!existsSync(verificationPath)) {
		writeFileSync(
			verificationPath,
			`<verification_mindset>
Assume your fix is wrong until proven otherwise.

A fix is verified when:
1. Original issue no longer occurs
2. You understand WHY the fix works
3. Related functionality still works
4. Fix works across environments
5. Fix is stable (not intermittent)

Red flag phrases: "It seems to work", "I think it's fixed"
Trust-building: "Verified 50 times - zero failures"
</verification_mindset>
`,
		);
	}
}
