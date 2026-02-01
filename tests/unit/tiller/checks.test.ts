/**
 * Tests for verification check runner
 */

import { describe, expect, test } from "vitest";
import { parseVerificationSectionFull } from "../../../src/tiller/verification/checks.js";

describe("parseVerificationSectionFull", () => {
	test("extracts command from start of line", () => {
		const planContent = `
<verification>
- \`tsc --noEmit\` passes
- \`npm test\` runs successfully
</verification>
`;
		const checks = parseVerificationSectionFull(planContent);
		expect(checks).toHaveLength(2);
		expect(checks[0].command).toBe("tsc --noEmit");
		expect(checks[1].command).toBe("npm test");
	});

	test("returns null for commands in middle of line (not auto-runnable)", () => {
		// Commands mid-sentence are descriptive, not auto-runnable
		// e.g., "No `Track` imports" should NOT become command "Track"
		const planContent = `
<verification>
- PRIME.md is tracked: \`git ls-files .tiller/PRIME.md\` returns path
- Local override: create file with \`echo "test" > file\`, verify works
</verification>
`;
		const checks = parseVerificationSectionFull(planContent);
		expect(checks).toHaveLength(2);
		// Mid-sentence backticks are not extracted as commands
		expect(checks[0].command).toBeNull();
		expect(checks[1].command).toBeNull();
	});

	test("returns null command for items without backticks", () => {
		const planContent = `
<verification>
- manual check without any commands
</verification>
`;
		const checks = parseVerificationSectionFull(planContent);
		expect(checks).toHaveLength(1);
		expect(checks[0].command).toBeNull();
	});

	test("returns empty array when no verification section", () => {
		const planContent = `
<objective>
Just an objective
</objective>
`;
		const checks = parseVerificationSectionFull(planContent);
		expect(checks).toHaveLength(0);
	});
});
