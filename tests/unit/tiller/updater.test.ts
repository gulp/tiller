/**
 * Tests for PLAN.md checkbox updater
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { updatePlanCheckboxes } from "../../../src/tiller/verification/updater.js";
import type { DerivedCheck } from "../../../src/tiller/types/index.js";

describe("updatePlanCheckboxes", () => {
	let tempDir: string;
	let planPath: string;

	beforeEach(() => {
		// Create temp directory for test files
		tempDir = mkdtempSync(join(tmpdir(), "tiller-updater-test-"));
		planPath = join(tempDir, "PLAN.md");
	});

	afterEach(() => {
		// Clean up temp directory
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("basic pass: unchecked checkbox becomes checked for passing check", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run build\` passes
- [ ] \`npm test\` passes
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "npm test", kind: "cmd", status: "pending" },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run build` passes");
		expect(updated).toContain("- [ ] `npm test` passes"); // pending stays unchecked
	});

	test("fail stays unchecked: failing check keeps checkbox unchecked", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run build\` passes
- [ ] \`npm test\` passes
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "npm test", kind: "cmd", status: "fail", exit_code: 1 },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run build` passes");
		expect(updated).toContain("- [ ] `npm test` passes"); // fail stays unchecked
	});

	test("manual preserved: manual checks remain unchanged", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run build\` passes
- [ ] Manual: Verify UI looks correct
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "Manual: Verify UI looks correct", kind: "manual", status: "pending" },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run build` passes");
		expect(updated).toContain("- [ ] Manual: Verify UI looks correct"); // manual unchanged
	});

	test("mixed results: multiple checks with pass/fail/manual mix", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run build\` passes
- [ ] \`npm test\` passes
- [ ] \`npm run lint\` passes
- [ ] Manual check: Verify output
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "npm test", kind: "cmd", status: "fail", exit_code: 1 },
			{ name: "npm run lint", kind: "cmd", status: "pass" },
			{ name: "Manual check: Verify output", kind: "manual", status: "pending" },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run build` passes");
		expect(updated).toContain("- [ ] `npm test` passes"); // fail stays unchecked
		expect(updated).toContain("- [x] `npm run lint` passes");
		expect(updated).toContain("- [ ] Manual check: Verify output"); // manual unchanged
	});

	test("idempotent: running twice with same results doesn't break", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run build\` passes
- [ ] \`npm test\` passes
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "npm test", kind: "cmd", status: "pass" },
		];

		// Run once
		updatePlanCheckboxes(planPath, checks);
		const firstUpdate = readFileSync(planPath, "utf-8");

		// Run again with same results
		updatePlanCheckboxes(planPath, checks);
		const secondUpdate = readFileSync(planPath, "utf-8");

		// Should be identical
		expect(secondUpdate).toBe(firstUpdate);
		expect(secondUpdate).toContain("- [x] `npm run build` passes");
		expect(secondUpdate).toContain("- [x] `npm test` passes");
	});

	test("already checked: check [x] stays [x] on re-run", () => {
		const content = `---
title: Test Plan
---

<verification>
- [x] \`npm run build\` passes
- [ ] \`npm test\` passes
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "npm test", kind: "cmd", status: "pass" },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run build` passes"); // already checked stays checked
		expect(updated).toContain("- [x] `npm test` passes"); // newly checked
	});

	test("no verification section: returns early without error", () => {
		const content = `---
title: Test Plan
---

# Plan without verification section

Some content here.
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
		];

		// Should not throw
		expect(() => updatePlanCheckboxes(planPath, checks)).not.toThrow();

		// Content should be unchanged
		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toBe(content);
	});

	test("regex escaping: check names with special chars", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run test:e2e\` passes
- [ ] \`echo "Hello (World)"\` works
- [ ] \`test [foo]\` runs
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run test:e2e", kind: "cmd", status: "pass" },
			{ name: 'echo "Hello (World)"', kind: "cmd", status: "pass" },
			{ name: "test [foo]", kind: "cmd", status: "pass" },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run test:e2e` passes");
		expect(updated).toContain('- [x] `echo "Hello (World)"` works');
		expect(updated).toContain("- [x] `test [foo]` runs");
	});

	test("error status stays unchecked: checks with errors are not marked as passed", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run build\` passes
- [ ] \`invalid-command\` runs
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "invalid-command", kind: "cmd", status: "error" },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run build` passes");
		expect(updated).toContain("- [ ] `invalid-command` runs"); // error stays unchecked
	});

	test("preserves indentation: nested checkboxes maintain spacing", () => {
		const content = `---
title: Test Plan
---

<verification>
- [ ] \`npm run build\` passes
  - [ ] \`npm run build:prod\` also passes
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "npm run build:prod", kind: "cmd", status: "pass" },
		];

		updatePlanCheckboxes(planPath, checks);

		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toContain("- [x] `npm run build` passes");
		expect(updated).toContain("  - [x] `npm run build:prod` also passes");
	});

	test("no changes: skips write when no checkboxes need updating", () => {
		const content = `---
title: Test Plan
---

<verification>
- [x] \`npm run build\` passes
- [ ] \`npm test\` pending
</verification>
`;
		writeFileSync(planPath, content);

		const checks: DerivedCheck[] = [
			{ name: "npm run build", kind: "cmd", status: "pass" },
			{ name: "npm test", kind: "cmd", status: "pending" },
		];

		updatePlanCheckboxes(planPath, checks);

		// Content should be unchanged
		const updated = readFileSync(planPath, "utf-8");
		expect(updated).toBe(content);
	});
});
