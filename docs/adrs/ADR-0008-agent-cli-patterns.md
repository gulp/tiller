# ADR-0008: Agent CLI Usage Patterns

**Status:** Proposed
**Date:** 2026-01-18

## Context

Agents interacting with CLIs naturally gravitate toward human-friendly flags like `--pretty` based on training data. This violates agent-first design:

```bash
# WRONG: Agent uses human flag
tiller list --state proposed --pretty

# RIGHT: Agent uses default (TOON), formats output itself
tiller list --state proposed
# Then: Parse TOON, follow agent_hint, format markdown
```

## Problem

1. **Training bias**: LLMs see `--pretty`, `--human`, `--verbose` in training data
2. **Path of least resistance**: `--pretty` gives immediate readable output
3. **Missed contract**: Agent bypasses structured data + formatting instructions

## Decision

**Agents MUST use default TOON output and format results themselves.**

### Flag semantics (lock this in)

| Flag | Audience | When to use |
|------|----------|-------------|
| (default) | Agent | Always - returns TOON with agent_hint |
| `--pretty` | Human in TTY | Never by agent |
| `--json` | Scripts/CI | Programmatic consumption |
| `--short` | Human quick glance | Never by agent |

### Agent contract

1. Run command with NO formatting flags
2. Receive TOON with `agent_hint`
3. Parse structured data
4. Follow `agent_hint` to format for user
5. Use AskUserQuestion if hint directs

## Mitigation Strategies

### 1. agent_hint reinforcement
Include in every TOON output:
```yaml
agent_hint: "Format as markdown. DO NOT re-run with --pretty."
```

### 2. Hook-based guardrail
PreToolUse hook that warns/blocks `--pretty` usage by agents:
```bash
if [[ "$TOOL_INPUT" =~ "--pretty" ]]; then
  echo "BLOCKED: Agents should use default TOON output"
  exit 1
fi
```

### 3. Training signal
Document pattern in CLAUDE.md:
```markdown
## CLI Usage
- NEVER use --pretty, --human, --verbose flags
- ALWAYS use default output and format TOON yourself
```

## Consequences

### Positive
- Agent controls presentation (ADR-0003 alignment)
- Structured data enables richer formatting
- agent_hint can include context-specific instructions

### Negative
- More code in agent to format
- Agents must resist training bias
- Need enforcement mechanisms

## References

- ADR-0003: TOON-First CLI Output
- CLAUDE.md constitutional principles
