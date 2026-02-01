/**
 * Tests for AST-based markdown parser
 */

import { describe, expect, test } from "vitest";
import {
	extractCheckboxItems,
	extractCodeBlocks,
	extractHtmlTag,
	extractListItems,
	extractListItemsWithCode,
	extractTextWithoutCode,
	hasHtmlTag,
} from "../../../src/tiller/markdown/parser.js";

describe("extractHtmlTag", () => {
	test("extracts tag content from markdown", () => {
		const content = `
# Plan

<verification>
- [ ] check 1
- [ ] check 2
</verification>
`;
		expect(extractHtmlTag(content, "verification")).toContain("check 1");
		expect(extractHtmlTag(content, "verification")).toContain("check 2");
	});

	test("ignores tags inside fenced code blocks", () => {
		const content = `
# Plan

\`\`\`typescript
const template = \`<verification>
- [ ] fake check
</verification>\`;
\`\`\`

<verification>
- [ ] real check
</verification>
`;
		const result = extractHtmlTag(content, "verification");
		expect(result).not.toContain("fake check");
		expect(result).toContain("real check");
	});

	test("returns null when tag not found", () => {
		const content = "# Just a heading";
		expect(extractHtmlTag(content, "verification")).toBeNull();
	});

	test("handles multiple code blocks before real tag", () => {
		// Note: remark parses multi-line HTML blocks as single nodes
		const content = `
\`\`\`js
<objective>fake1</objective>
\`\`\`

\`\`\`python
<objective>fake2</objective>
\`\`\`

<objective>
real objective
</objective>
`;
		const result = extractHtmlTag(content, "objective");
		expect(result).not.toBeNull();
		expect(result).not.toContain("fake1");
		expect(result).not.toContain("fake2");
		expect(result).toContain("real objective");
	});
});

describe("extractTextWithoutCode", () => {
	test("excludes fenced code blocks", () => {
		const content = `
Regular text

\`\`\`
code block content
\`\`\`

More text
`;
		const result = extractTextWithoutCode(content);
		expect(result).toContain("Regular text");
		expect(result).toContain("More text");
		expect(result).not.toContain("code block content");
	});
});

describe("extractCodeBlocks", () => {
	test("extracts all code blocks with language", () => {
		const content = `
\`\`\`typescript
const x = 1;
\`\`\`

\`\`\`python
y = 2
\`\`\`
`;
		const blocks = extractCodeBlocks(content);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].lang).toBe("typescript");
		expect(blocks[0].value).toContain("const x = 1");
		expect(blocks[1].lang).toBe("python");
	});
});

describe("extractListItems", () => {
	test("extracts list item text", () => {
		const content = `
- item one
- item two
- item three
`;
		const items = extractListItems(content);
		expect(items).toContain("item one");
		expect(items).toContain("item two");
		expect(items).toContain("item three");
	});
});

describe("extractListItemsWithCode", () => {
	test("preserves inline code with backticks", () => {
		const content = `
- \`tsc --noEmit\` passes
- \`npm test\` runs successfully
- manual check without code
`;
		const items = extractListItemsWithCode(content);
		expect(items).toHaveLength(3);
		expect(items[0]).toBe("`tsc --noEmit` passes");
		expect(items[1]).toBe("`npm test` runs successfully");
		expect(items[2]).toBe("manual check without code");
	});

	test("handles checkbox-style list items", () => {
		const content = `
- [ ] \`command\` description
- [x] completed item
`;
		const items = extractListItemsWithCode(content);
		// Note: checkbox markers become text nodes in AST
		expect(items[0]).toContain("`command`");
		expect(items[0]).toContain("description");
	});

	test("handles verification section format", () => {
		const content = `
<verification>
- \`tsc --noEmit\` passes
- \`tiller verify\` runs phase-level health check
- manual verification step
</verification>
`;
		const section = extractHtmlTag(content, "verification");
		expect(section).not.toBeNull();
		const items = extractListItemsWithCode(section!);
		expect(items).toHaveLength(3);
		expect(items[0]).toContain("`tsc --noEmit`");
	});
});

describe("hasHtmlTag", () => {
	test("returns true when tag exists", () => {
		const content = `
<verification>
- check
</verification>
`;
		expect(hasHtmlTag(content, "verification")).toBe(true);
	});

	test("returns false when tag does not exist", () => {
		const content = "# Just markdown";
		expect(hasHtmlTag(content, "verification")).toBe(false);
	});

	test("returns false for tag inside code block", () => {
		const content = `
\`\`\`
<verification>fake</verification>
\`\`\`
`;
		expect(hasHtmlTag(content, "verification")).toBe(false);
	});
});

describe("extractCheckboxItems", () => {
	test("extracts unchecked items", () => {
		const content = `
- [ ] item one
- [ ] item two
`;
		const items = extractCheckboxItems(content);
		expect(items).toHaveLength(2);
		expect(items[0].checked).toBe(false);
		expect(items[0].text).toBe("item one");
		expect(items[1].checked).toBe(false);
		expect(items[1].text).toBe("item two");
	});

	test("extracts checked items", () => {
		const content = `
- [x] completed task
- [X] also completed
`;
		const items = extractCheckboxItems(content);
		expect(items).toHaveLength(2);
		expect(items[0].checked).toBe(true);
		expect(items[1].checked).toBe(true);
	});

	test("extracts mixed checked/unchecked items", () => {
		const content = `
- [ ] pending
- [x] done
- [ ] also pending
`;
		const items = extractCheckboxItems(content);
		expect(items).toHaveLength(3);
		expect(items[0].checked).toBe(false);
		expect(items[1].checked).toBe(true);
		expect(items[2].checked).toBe(false);
	});

	test("ignores non-checkbox list items", () => {
		const content = `
- regular item
- [ ] checkbox item
- another regular
`;
		const items = extractCheckboxItems(content);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe("checkbox item");
	});

	test("preserves inline code in checkbox text", () => {
		const content = `
- [ ] \`tsc --noEmit\` passes
- [x] run \`bun test\` successfully
`;
		const items = extractCheckboxItems(content);
		expect(items).toHaveLength(2);
		expect(items[0].text).toContain("`tsc --noEmit`");
		expect(items[1].text).toContain("`bun test`");
	});

	test("handles nested list with checkboxes", () => {
		const content = `
- [ ] parent task
  - [ ] child task
  - [x] completed child
`;
		const items = extractCheckboxItems(content);
		expect(items.length).toBeGreaterThanOrEqual(2);
	});

	test("returns empty array for content without checkboxes", () => {
		const content = `
# Just a heading

Some paragraph text.
`;
		const items = extractCheckboxItems(content);
		expect(items).toHaveLength(0);
	});
});
