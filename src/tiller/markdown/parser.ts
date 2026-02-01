/**
 * AST-based markdown parser using remark/unified
 *
 * Provides utilities for extracting content from markdown while
 * structurally excluding code blocks (fenced and inline).
 */

import type { Code, Html, InlineCode, Root, Text } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * Parse markdown content to AST (with GFM support for checkboxes, tables, etc.)
 */
export function parseMarkdown(content: string): Root {
	return unified().use(remarkParse).use(remarkGfm).parse(content);
}

/**
 * Extract text and HTML content, excluding code blocks
 * Returns concatenated text from non-code nodes
 */
export function extractTextWithoutCode(content: string): string {
	const tree = parseMarkdown(content);
	const parts: string[] = [];

	visit(tree, (node, _index, _parent) => {
		// Skip code and inlineCode nodes entirely
		if (node.type === "code" || node.type === "inlineCode") {
			return "skip";
		}

		// Collect text and html node values
		if (node.type === "text") {
			parts.push((node as Text).value);
		} else if (node.type === "html") {
			parts.push((node as Html).value);
		}
	});

	return parts.join("\n");
}

/**
 * Extract content between HTML-style tags (e.g., <verification>...</verification>)
 * Uses AST to find HTML nodes directly - no regex on extracted text
 *
 * Handles two CommonMark parsing scenarios:
 * 1. Single HTML block (tag + content + close tag together)
 * 2. Split nodes (open tag, content, close tag as separate nodes)
 *
 * Also handles trailing content after close tag (e.g., comments)
 *
 * @param content - Raw markdown content
 * @param tag - Tag name without angle brackets (e.g., "verification")
 * @returns Tag content or null if not found
 */
export function extractHtmlTag(content: string, tag: string): string | null {
	const tree = parseMarkdown(content);
	const openTag = `<${tag}>`;
	const closeTag = `</${tag}>`;

	// First pass: look for single HTML block containing both tags
	// Use LAST match (plan files may have examples earlier, real section at end)
	let result: string | null = null;
	visit(tree, "html", (node: Html) => {
		const value = node.value;
		// Handle case where close tag may be followed by other content (comments, etc.)
		if (value.startsWith(openTag) && value.includes(closeTag)) {
			const closeIdx = value.indexOf(closeTag);
			result = value.slice(openTag.length, closeIdx);
			// Don't return early - keep going to find the LAST match
		}
	});
	if (result !== null) return result;

	// Second pass: look for split open/close tags and extract content between
	// Use LAST pair (for the same reason as above)
	let openOffset = -1;
	let closeOffset = -1;

	visit(tree, "html", (node: Html) => {
		const value = node.value.trim();
		if (value.startsWith(openTag)) {
			// Reset - start looking for a new pair from this open tag
			openOffset = node.position?.end?.offset ?? -1;
			closeOffset = -1;
		}
		if (value.startsWith(closeTag) && openOffset >= 0) {
			closeOffset = node.position?.start?.offset ?? -1;
		}
	});

	if (openOffset >= 0 && closeOffset >= 0) {
		return content.slice(openOffset, closeOffset).trim();
	}

	return null;
}

/**
 * Extract all code blocks from markdown
 */
export function extractCodeBlocks(
	content: string,
): Array<{ lang: string | null; value: string }> {
	const tree = parseMarkdown(content);
	const blocks: Array<{ lang: string | null; value: string }> = [];

	visit(tree, "code", (node: Code) => {
		blocks.push({
			lang: node.lang || null,
			value: node.value,
		});
	});

	return blocks;
}

/**
 * Extract all list items from markdown (text only, strips inline code)
 */
export function extractListItems(content: string): string[] {
	const tree = parseMarkdown(content);
	const items: string[] = [];

	visit(tree, "listItem", (node) => {
		// Get text content from list item
		let text = "";
		visit(node, "text", (textNode: Text) => {
			text += textNode.value;
		});
		if (text) {
			items.push(text.trim());
		}
	});

	return items;
}

/**
 * Extract list items preserving inline code with backticks
 * Returns items like: "`command` description"
 */
export function extractListItemsWithCode(content: string): string[] {
	const tree = parseMarkdown(content);
	const items: string[] = [];

	visit(tree, "listItem", (node) => {
		const parts: string[] = [];

		visit(node, (child) => {
			if (child.type === "text") {
				parts.push((child as Text).value);
			} else if (child.type === "inlineCode") {
				// Preserve backticks around inline code
				parts.push(`\`${(child as InlineCode).value}\``);
			}
		});

		const text = parts.join("").trim();
		if (text) {
			items.push(text);
		}
	});

	return items;
}

/**
 * Check if content has a specific HTML-style tag (outside code blocks)
 */
export function hasHtmlTag(content: string, tag: string): boolean {
	return extractHtmlTag(content, tag) !== null;
}

/**
 * Extract all HTML-style tags with their attributes
 * Returns array of tag content with type attribute
 */
export function extractAllTags(
	content: string,
	tag: string,
): Array<{ type: string | null; content: string }> {
	const tree = parseMarkdown(content);
	const results: Array<{ type: string | null; content: string }> = [];

	// Regex to extract type attribute from opening tag
	const typeRegex = new RegExp(`<${tag}\\s+type="([^"]+)"[^>]*>`, "i");

	visit(tree, "html", (node: Html) => {
		const value = node.value;
		const openPattern = `<${tag}`;
		const closeTag = `</${tag}>`;

		if (value.startsWith(openPattern) && value.includes(closeTag)) {
			// Extract type attribute
			const typeMatch = value.match(typeRegex);
			const type = typeMatch ? typeMatch[1] : null;

			// Extract content between tags
			const openEnd = value.indexOf(">") + 1;
			const closeStart = value.indexOf(closeTag);
			const tagContent = value.slice(openEnd, closeStart).trim();

			results.push({ type, content: tagContent });
		}
	});

	return results;
}

/**
 * Parse checkpoint tasks from PLAN.md <tasks> section
 *
 * GSD-style checkpoint format:
 * <task type="checkpoint:human-verify">
 *   <gate>blocking</gate>
 *   <what-built>...</what-built>
 *   <how-to-verify>...</how-to-verify>
 *   <resume-signal>...</resume-signal>
 * </task>
 *
 * @param content - Raw markdown content (full PLAN.md or just <tasks> section)
 * @returns Array of parsed checkpoint tasks
 */
export function extractCheckpointTasks(
	content: string,
): Array<{
	type: "human-verify" | "decision" | "human-action";
	gate: "blocking" | "informational";
	whatBuilt: string;
	howToVerify: string;
	resumeSignal: string;
}> {
	const tasks = extractAllTags(content, "task");
	const checkpoints: Array<{
		type: "human-verify" | "decision" | "human-action";
		gate: "blocking" | "informational";
		whatBuilt: string;
		howToVerify: string;
		resumeSignal: string;
	}> = [];

	for (const task of tasks) {
		// Only process checkpoint types
		if (!task.type?.startsWith("checkpoint:")) {
			continue;
		}

		// Parse checkpoint type
		const typeStr = task.type.replace("checkpoint:", "");
		if (!["human-verify", "decision", "human-action"].includes(typeStr)) {
			continue;
		}

		// Extract nested fields using simple tag extraction
		const extractField = (fieldContent: string, field: string): string => {
			const openTag = `<${field}>`;
			const closeTag = `</${field}>`;
			const start = fieldContent.indexOf(openTag);
			const end = fieldContent.indexOf(closeTag);
			if (start === -1 || end === -1) return "";
			return fieldContent.slice(start + openTag.length, end).trim();
		};

		const gate = extractField(task.content, "gate");
		const whatBuilt = extractField(task.content, "what-built");
		const howToVerify = extractField(task.content, "how-to-verify");
		const resumeSignal = extractField(task.content, "resume-signal");

		// Only add if we have the required fields
		if (whatBuilt || howToVerify) {
			checkpoints.push({
				type: typeStr as "human-verify" | "decision" | "human-action",
				gate: gate === "informational" ? "informational" : "blocking",
				whatBuilt,
				howToVerify,
				resumeSignal: resumeSignal || "Type approved or describe issues",
			});
		}
	}

	return checkpoints;
}

/**
 * Checkbox item from markdown list
 */
export interface CheckboxItem {
	checked: boolean;
	text: string;
}

/**
 * Extract checkbox list items (e.g., "- [x] item" or "- [ ] item")
 * Returns items with their checked state and text content
 */
export function extractCheckboxItems(content: string): CheckboxItem[] {
	const tree = parseMarkdown(content);
	const items: CheckboxItem[] = [];

	visit(tree, "listItem", (node) => {
		// Check if node has checked property (GFM checkbox)
		const checked = (node as any).checked;
		if (typeof checked !== "boolean") {
			return; // Not a checkbox item
		}

		// Extract text from item
		const parts: string[] = [];
		visit(node, (child) => {
			if (child.type === "text") {
				parts.push((child as Text).value);
			} else if (child.type === "inlineCode") {
				parts.push(`\`${(child as InlineCode).value}\``);
			}
		});

		const text = parts.join("").trim();
		if (text) {
			items.push({ checked, text });
		}
	});

	return items;
}
