# Development Workflow

**Always use `bun`, not `npm`. Never use `tsc` directly.**

**Typecheck strategy:** IDE diagnostics catch errors during development. Run `tsc --noEmit` at session end or pre-commit, not after every edit. This keeps iteration fast while CI catches any misses.

**Critical:** To prevent hitting a classic LLM-editor impedance mismatch; after any code edit, treat all prior diagnostics as invalid until the full file is reread; never reason about errors, imports, or structure without a read-after-write sync.

## Testing

- ALWAYS use vitest: `bun run test` (NOT `bun test` - that's a different runner).
- Run targeted tests only: `bun run test <pattern>` (vitest 4 uses positional args, NOT --filter).
- Use fast mode when available: `TILLER_FAST=1`.

## Build

- `bun run build` - compile TypeScript
- `bun run test` - run tests
- `tsc --noEmit` - type check only

## Design Principles

**Every architectural decision must be agent-first.**

When designing schemas, state machines, APIs, or file formats, consider:

1. **Semantic Ambiguity** - Avoid notation that collides with programming constructs
   - Bad: `state.substate` (looks like property access)
   - Good: `state/substate` (clear hierarchy)

2. **Tokenization** - Choose separators that create clean token boundaries

3. **Training Bias** - LLMs have strong priors from code
   - `foo.bar` → "property access"
   - `foo/bar` → "path or hierarchy"
   - `foo:bar` → "namespace or label"

4. **Queryability** - Design for both human CLI and agent parsing
   - Machine-readable (JSON, YAML frontmatter)
   - Human-scannable (prose sections, clear headings)

**Litmus test:** "If an LLM sees this out of context, will it understand the intent?"
