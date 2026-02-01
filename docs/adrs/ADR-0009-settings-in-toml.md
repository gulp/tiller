# ADR-0009: Settings in tiller.toml, Not PRIME.md

**Status:** Accepted
**Date:** 2026-01-18

## Context

Tiller has two configuration surfaces:
1. `.tiller/tiller.toml` - Machine-readable configuration
2. `.tiller/PRIME.md` - Context injection for agents (shown via `tiller prime`)

Settings have accumulated in PRIME.md as markdown comments or prose, mixing configuration with documentation.

## Problem

1. **Parsing complexity**: Extracting settings from markdown requires regex/MQ queries
2. **Semantic confusion**: PRIME.md is for *reading*, not *configuring*
3. **Tool support**: TOML has native parsing; markdown settings are ad-hoc
4. **Single source of truth**: Settings split across files creates drift

## Decision

**All tiller settings MUST live in `tiller.toml`. PRIME.md is documentation only.**

### File responsibilities

| File | Purpose | Read by |
|------|---------|---------|
| `tiller.toml` | Configuration (settings, paths, workflow) | CLI code |
| `PRIME.md` | Agent context (docs, hints, examples) | Agents via stdout |

### Migration

Settings currently in PRIME.md must move to tiller.toml:

```toml
# tiller.toml
[workflow]
confirm_mode = false
require_summary = true
current_initiative = "tiller-cli"

[env]
# Environment variable documentation (not values)
# TILLER_DEBUG = "Enable verbose error logging"
```

PRIME.md becomes pure documentation:
```markdown
## Environment Variables
- `TILLER_DEBUG=1` - Enable verbose error logging
```

### What goes where

| Type | Location | Example |
|------|----------|---------|
| Runtime config | tiller.toml | `confirm_mode`, `current_initiative` |
| Path mappings | tiller.toml | `plans_dir`, `runs_dir` |
| Documentation | PRIME.md | Usage examples, env var docs |
| Workflow hints | PRIME.md | "Run `tiller activate` to start" |

## Consequences

### Positive
- Single source of truth for config
- Native TOML parsing (no regex)
- Clear separation: config vs docs
- Easier tooling (schema validation, IDE support)

### Negative
- Migration effort for existing projects
- Two files to understand

## References

- Related: 11-07 plan (Move tiller settings from PRIME.md to tiller.toml)
