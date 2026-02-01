/**
 * Tests for verification parser format detection
 *
 * Tests the three-format distinction:
 * - YAML: explicit cmd/manual with name: field
 * - Checkbox: `- [ ]` with backticks = cmd, else manual
 * - Prose: no checkboxes, all manual (agent-interpreted)
 */

import { describe, expect, test } from "vitest";
import {
	hasCheckboxFormat,
	parseVerification,
} from "../../../src/tiller/verification/parser.js";

describe("verification format detection", () => {
	describe("hasCheckboxFormat", () => {
		test("returns true for unchecked checkbox", () => {
			expect(hasCheckboxFormat("- [ ] some task")).toBe(true);
		});

		test("returns true for checked checkbox", () => {
			expect(hasCheckboxFormat("- [x] completed task")).toBe(true);
		});

		test("returns true for checkbox with asterisk", () => {
			expect(hasCheckboxFormat("* [ ] asterisk task")).toBe(true);
		});

		test("returns false for plain bullet", () => {
			expect(hasCheckboxFormat("- plain item")).toBe(false);
		});

		test("returns false for prose with backticks", () => {
			expect(hasCheckboxFormat("- `cmd` does something")).toBe(false);
		});
	});

	describe("parseVerification format detection", () => {
		test("detects YAML format", () => {
			const content = `
<verification>
- name: type_check
  cmd: tsc --noEmit
- name: uat_review
  manual: true
</verification>
`;
			const result = parseVerification(content);
			expect(result.success).toBe(true);
			expect(result.format).toBe("yaml");
			expect(result.checks).toHaveLength(2);
			expect(result.checks[0].cmd).toBe("tsc --noEmit");
			expect(result.checks[1].manual).toBe(true);
		});

		test("detects checkbox format", () => {
			const content = `
<verification>
- [ ] \`tsc --noEmit\` passes
- [ ] \`bun run test\` passes
- [ ] Manual acceptance criteria
</verification>
`;
			const result = parseVerification(content);
			expect(result.success).toBe(true);
			expect(result.format).toBe("checkbox");
			expect(result.checks).toHaveLength(3);
		});

		test("detects prose format (no checkboxes)", () => {
			const content = `
<verification>
- \`tiller phase insert 06\` creates phase 07
- Existing phase 07 renamed to 08
- ROADMAP.md updated correctly
</verification>
`;
			const result = parseVerification(content);
			expect(result.success).toBe(true);
			expect(result.format).toBe("prose");
			expect(result.checks).toHaveLength(3);
		});

		test("returns empty format for missing section", () => {
			const content = "# Just a heading";
			const result = parseVerification(content);
			expect(result.success).toBe(true);
			expect(result.format).toBe("empty");
			expect(result.checks).toHaveLength(0);
		});
	});

	describe("checkbox format parsing", () => {
		test("backtick command at start becomes cmd check", () => {
			const content = `
<verification>
- [ ] \`tsc --noEmit\` passes
</verification>
`;
			const result = parseVerification(content);
			expect(result.format).toBe("checkbox");
			expect(result.checks[0].cmd).toBe("tsc --noEmit");
			expect(result.checks[0].manual).toBeUndefined();
		});

		test("non-backtick item becomes manual check", () => {
			const content = `
<verification>
- [ ] Manual acceptance criteria
</verification>
`;
			const result = parseVerification(content);
			expect(result.format).toBe("checkbox");
			expect(result.checks[0].manual).toBe(true);
			expect(result.checks[0].cmd).toBeUndefined();
		});

		test("mixed cmd and manual in checkbox format", () => {
			const content = `
<verification>
- [ ] \`tsc --noEmit\` passes
- [ ] Manual UAT check
- [x] \`bun run test\` passes (already done)
</verification>
`;
			const result = parseVerification(content);
			expect(result.format).toBe("checkbox");
			expect(result.checks).toHaveLength(3);

			// First: cmd check
			expect(result.checks[0].cmd).toBe("tsc --noEmit");
			expect(result.checks[0].manual).toBeUndefined();

			// Second: manual check
			expect(result.checks[1].manual).toBe(true);
			expect(result.checks[1].cmd).toBeUndefined();

			// Third: cmd check (even if already checked)
			expect(result.checks[2].cmd).toBe("bun run test");
		});

		test("checkbox state does not affect cmd detection", () => {
			const content = `
<verification>
- [ ] \`unchecked cmd\` task
- [x] \`checked cmd\` task
</verification>
`;
			const result = parseVerification(content);
			expect(result.checks[0].cmd).toBe("unchecked cmd");
			expect(result.checks[1].cmd).toBe("checked cmd");
		});

		test("preserves description with cmd", () => {
			const content = `
<verification>
- [ ] \`tsc --noEmit\` type check must pass
</verification>
`;
			const result = parseVerification(content);
			expect(result.checks[0].description).toBe(
				"`tsc --noEmit` type check must pass",
			);
		});
	});

	describe("prose format parsing", () => {
		test("all items become manual checks", () => {
			const content = `
<verification>
- \`tiller phase insert 06\` creates phase 07
- ROADMAP.md updated correctly
</verification>
`;
			const result = parseVerification(content);
			expect(result.format).toBe("prose");
			expect(result.checks[0].manual).toBe(true);
			expect(result.checks[1].manual).toBe(true);
		});

		test("backticks in prose are context, not cmd", () => {
			const content = `
<verification>
- \`tiller phase insert 06\` creates phase 07
</verification>
`;
			const result = parseVerification(content);
			expect(result.format).toBe("prose");
			// In prose, backticks are NOT treated as cmd
			expect(result.checks[0].cmd).toBeUndefined();
			expect(result.checks[0].manual).toBe(true);
		});
	});

	describe("edge cases", () => {
		test("handles empty verification section", () => {
			const content = `
<verification>
</verification>
`;
			const result = parseVerification(content);
			expect(result.success).toBe(true);
			expect(result.checks).toHaveLength(0);
		});

		test("ignores comments in verification section", () => {
			const content = `
<verification>
<!-- This is a comment -->
- [ ] \`tsc --noEmit\` passes
</verification>
`;
			const result = parseVerification(content);
			expect(result.checks).toHaveLength(1);
		});

		test("handles complex backtick commands", () => {
			const content = `
<verification>
- [ ] \`TILLER_DEBUG=1 tiller verify --auto\` runs without error
</verification>
`;
			const result = parseVerification(content);
			expect(result.checks[0].cmd).toBe(
				"TILLER_DEBUG=1 tiller verify --auto",
			);
		});
	});
});
