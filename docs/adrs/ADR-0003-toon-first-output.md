# ADR-0003: TOON-First CLI Output

**Status:** Proposed
**Date:** 2026-01-16
**Decision Makers:** @gulp

## Context

Tiller CLI commands currently output human-readable formatted text to stdout:

```
Phase 06.6 Health Check
═══════════════════════════════════════════════════════
  ✓ 06.6-01 [complete]
  ● 06.6-02 [active/executing]
...
```

This works for human-in-terminal workflows but has limitations:

1. **Agent blindness** - Claude Code can't see verbose command output; users report "I can't see that"
2. **Inconsistent contracts** - Each command has its own output format
3. **Parsing fragility** - Agents that need to parse output must regex match formatted text
4. **Presentation coupling** - CLI decides how to present, not the agent

## Decision

**All tiller commands return TOON by default.**

Agent receives structured data, decides how to present to user:

```yaml
phase_status:
  phase: "06.6"
  name: tiller-ax-friction
  plans:
    - ref: "06.6-01"
      state: complete
    - ref: "06.6-02"
      state: active/executing
  checks:
    tsc: pass
    git_clean: true
```

Agent formats as markdown table, prose, or summary based on context.

## Options Considered

### Option A: `--toon` flag per command
Add flag to each command that needs it.

**Pros:** Incremental, backward compatible
**Cons:** Inconsistent, opt-in burden

### Option B: TOON default, `--pretty` for human (Chosen)
Invert the default. Structured output first.

**Pros:** Agent-first by default, consistent contract
**Cons:** Breaking change for human terminal usage

### Option C: Detect TTY
Auto-switch based on terminal detection.

**Pros:** Automatic
**Cons:** Magic behavior, harder to test

## Implementation

1. Create `formatTOON(data)` helper for consistent TOON output
2. Refactor each command to build data structure, then output via `formatTOON`
3. Add `--pretty` flag for human-readable fallback
4. Document TOON schemas per command

## Consequences

### Positive
- Agent-first design (constitutional alignment)
- Consistent output contract
- Agent controls presentation to user
- Easier to test (structured data vs string matching)

### Negative
- Breaking change for existing human workflows
- More code in agent to format output
- TOON schema documentation needed

## References

- [TOON Format](https://toonformat.dev)
- ADR-0002: AST-Based Markdown Parsing (agent-first rationale)
- CLAUDE.md constitutional principles
