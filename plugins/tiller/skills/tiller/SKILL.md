---
name: tiller
description: >
  Intent state tracking for multi-session work. Use when executing plans,
  verifying work, or tracking progress across sessions. Provides HSM-based
  workflow with verification gates.
version: "0.2.0"
---

# Tiller - Intent State Tracking

Track work intent through hierarchical state machine. Plans → Tracks → Verification → Completion.

## tiller vs GSD

| tiller | GSD |
|--------|-----|
| HSM state tracking | Linear phase execution |
| Verification gates | Manual UAT |
| Track persistence | Session-scoped |
| Multi-agent ready | Single-agent |

**Decision test**: "Does this need state tracking?" → YES = tiller

## Prerequisites

```bash
tiller --version
```

## Quick Start

```bash
bun run tiller -- status     # What's the state?
bun run tiller -- list       # All tracks
bun run tiller -- show <id>  # Track details
```

## Routing by State

| State | Next Action |
|-------|-------------|
| No tracks | `tiller init <plan>` |
| `proposed` | `tiller activate` |
| `active/*` | Execute tasks from PLAN.md |
| `verifying/testing` | `tiller verify --pass` or `--fail` |
| `verifying/passed` | `tiller complete` |
| `verifying/failed` | `tiller fix` then re-verify |

## Workflow: Execute Plan

1. **Check state**: `bun run tiller -- status`
2. **Initialize**: `bun run tiller -- init <plan-path>`
3. **Activate**: `bun run tiller -- activate <track-id>`
4. **Execute tasks** from `<tasks>` section in PLAN.md
5. **Verify**: `bun run tiller -- verify <track-id>`

## Workflow: Verification

```bash
# Start UAT
bun run tiller -- verify <track-id>

# Record result
bun run tiller -- verify <track-id> --pass
bun run tiller -- verify <track-id> --fail --issue "description"
```

## Workflow: Fix Issues

```bash
# Create fix plan
bun run tiller -- fix <track-id>

# After fixing
bun run tiller -- fix <track-id> --done

# Re-verify
bun run tiller -- verify <track-id>
```

## Workflow: Complete

```bash
# After verifying/passed
bun run tiller -- complete <track-id>

# Skip verification (use sparingly)
bun run tiller -- complete <track-id> --skip-verify
```

## Agent-Friendly Flags

**Global:**
- `--yes` / `-y` - Skip confirmation prompts

**State changes:**
- `--reason "..."` - Document why (stored in transition history)

```bash
# Non-interactive abandon with reason
bun run tiller --yes abandon <track-id> --reason "plugin removed"

# Non-interactive rework with reason
bun run tiller --yes rework <track-id> --reason "found edge case"
```

## CLI Reference

Run `bun run tiller -- --help` for all commands.
Run `bun run tiller -- <command> --help` for command options.
