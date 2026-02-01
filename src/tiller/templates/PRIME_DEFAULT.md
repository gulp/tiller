# Tiller Workflow Context

> **Context Recovery**: Run `tiller prime` after compaction, clear, or new session
> Hooks auto-call this in Claude Code when .tiller/ detected

# 🚨 SESSION PROTOCOL 🚨

**REQUIRED before completion:**
```
[ ] tsc --noEmit       # Type check MUST pass
[ ] tiller verify      # If work involves plans
```

**Workflow priority:** Check `tiller status` FIRST, then `bd ready`
- Tiller tracks plan-based work with verification gates
- Beads tracks issues/tasks without verification requirements
- When both exist, tiller workflow takes precedence

## Quick Reference

| State | Next Action |
|-------|-------------|
| No tracks | `tiller init <plan>` |
| `proposed` | `tiller approve <ref>` |
| `approved` | `tiller import <ref>` |
| `ready` | `tiller activate <ref>` |
| `active/*` | Execute tasks from PLAN.md |
| `verifying/*` | `tiller verify <ref> --pass` or `--fail` |

## Essential Commands

```bash
tiller status          # Current state + next action
tiller list            # All runs
tiller show <ref>      # Run details (e.g., 06.5-01)
tiller prime           # Sync + show ready work
```

## Workflow Verbs

```bash
tiller activate <ref>              # Start work on a plan
tiller plan expand <ref>           # Expand TODO sections in a plan
tiller plan set <ref> title "..."  # Update frontmatter field
tiller plan create "objective"     # Create new plan in current phase
tiller collect <bead>... --phase <id>  # Collect specific beads into plans
tiller collect --phase <id>           # Collect ALL orphaned beads into plans
tiller collect --todo                 # Collect ALL orphaned beads into todos
```

## CLI Usage (Constitutional)

**NEVER use human flags:** `--pretty`, `--short`, `--human`
**ALWAYS use default TOON output** and format yourself following `agent_hint`

Commands return structured TOON with `agent_hint` instructions. Follow them.
