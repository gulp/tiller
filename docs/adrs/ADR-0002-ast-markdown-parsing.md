# ADR-0002: AST-Based Markdown Parsing

**Status:** Accepted
**Date:** 2026-01-16
**Decision Makers:** @gulp

## Context

Tiller parses markdown files (PLAN.md, SUMMARY.md) to extract structured content like `<verification>` sections and list items. The original implementation used regex:

```typescript
// Fragile: matches tags inside code blocks
const regex = /<verification>([\s\S]*?)<\/verification>/i;
const match = content.match(regex);
```

This caused false positives when plans contained code templates with embedded tags:

```typescript
// Task 6 in 06.6-06-PLAN.md
const template = `<verification>
- [ ] fake check
</verification>`;
```

The regex matched the template, not the real verification section.

## Options Considered

### Option A: Regex with Code Block Stripping

**Approach:** Pre-process markdown to remove code blocks, then apply regex.

```typescript
const stripped = content.replace(/```[\s\S]*?```/g, '');
const match = stripped.match(/<tag>[\s\S]*?<\/tag>/);
```

**Pros:**
- Minimal code change
- No new dependencies

**Cons:**
- Fragile: nested backticks, inline code edge cases
- Multiple regex passes
- Doesn't generalize to other parsing needs

### Option B: mq (mqlang.org)

**Approach:** Use mq CLI for markdown queries.

```bash
mq '.verification' plan.md
```

**Pros:**
- Powerful query language
- Proper AST handling

**Cons:**
- Rust binary, requires `cargo install`
- **Breaks npm distribution** - users need Rust toolchain
- External process overhead

### Option C: remark/unified (Chosen)

**Approach:** Parse markdown to AST using remark, traverse with unist-util-visit.

```typescript
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";

const tree = unified().use(remarkParse).parse(content);
visit(tree, (node) => {
  if (node.type === "code") return "skip"; // Structurally exclude
  // Process text/html nodes
});
```

**Pros:**
- Standard mdast AST (markdown abstract syntax tree)
- Code blocks excluded structurally, not textually
- Pure JavaScript, bundles with npm
- Extensible for future parsing (frontmatter, custom nodes)
- Well-maintained ecosystem (remarkjs)

**Cons:**
- New dependencies (4 packages, ~200KB)
- Learning curve for AST traversal

## Decision

**Accepted: Option C (remark/unified)**

Rationale:
1. **npm-distributable** - Pure JS, no external binaries
2. **Structural correctness** - AST excludes code nodes by type, not pattern
3. **Extensible** - Same foundation for future markdown processing
4. **Agent-first** - AST representation is unambiguous for LLM parsing

## Implementation

New module: `src/tiller/markdown/parser.ts`

```typescript
// Core functions
parseMarkdown(content)           // → mdast Root
extractTextWithoutCode(content)  // → string (code excluded)
extractHtmlTag(content, tag)     // → string | null (finds HTML block nodes)
extractListItemsWithCode(content) // → string[] (preserves backticks)
```

### CommonMark HTML Block Behavior

Per CommonMark spec, Type 7 HTML blocks require the opening tag to end the line:

```markdown
// ✓ Parsed as single HTML node (block)
<verification>
- item
</verification>

// ✗ Parsed as inline HTML (separate nodes)
<verification>content</verification>
```

Our implementation relies on multi-line format (which PLAN files use).
This is intentional - single-line custom tags are rare in structured documents.

Usage in verification:
```typescript
// Before (regex, fragile)
const match = content.match(/<verification>[\s\S]*?<\/verification>/);

// After (AST, robust)
const section = extractHtmlTag(content, "verification");
const items = extractListItemsWithCode(section);
```

## Consequences

### Positive
- Verification parsing no longer fooled by code templates
- Foundation for future markdown processing (task extraction, frontmatter)
- Tests can use real-world PLAN.md files with embedded code

### Negative
- 4 new npm dependencies
- Slightly more complex debugging (AST vs string)

### Neutral
- Performance similar (AST parse is fast, single pass)

## References

- [remark-parse](https://github.com/remarkjs/remark/tree/main/packages/remark-parse) - Markdown parser
- [unified](https://unifiedjs.com/) - Content processing ecosystem
- [mdast](https://github.com/syntax-tree/mdast) - Markdown AST spec
- [unist-util-visit](https://github.com/syntax-tree/unist-util-visit) - AST traversal
