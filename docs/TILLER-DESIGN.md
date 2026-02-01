# Tiller Design Specification

> [!CAUTION]
> **This document is substantially outdated.** It was written during Tiller's early design
> and has not been updated to reflect the implemented system. Key drifts:
> - Uses "track" terminology (now "run" per ADR-0004)
> - Shows flat state machine (actual: HSM with slash notation — `active/executing`, `verifying/passed`)
> - Documents ~15 commands (actual: 40+)
> - Shows JSON config (actual: TOML via `tiller.toml` per ADR-0009)
> - Shows `.tiller/tracks/` paths (actual: `.tiller/runs/`)
>
> **Source of truth:** `src/tiller/types/index.ts` for states, `src/tiller/commands/` for CLI.
> States: `proposed → approved → ready → active/* → verifying/* → complete`

A CLI system for managing intent over time with a human firmly at the tiller.

## Design Principle: Agent Autonomy

**Problem with GSD:** Agent outputs "Next: /gsd:plan-phase 2" and waits for user to type the command. This is unnecessary ceremony.

**Tiller enables:**
```bash
# Agent queries state
tiller status --json

# Agent sees: { "next_action": "plan", "phase": 2, "ready": true }
# Agent autonomously proceeds (or AskUserQuestion if genuinely uncertain)
```

**Key insight:** The agent should be able to:
1. Query `tiller status` to know exactly where we are
2. Determine next logical action from state
3. Proceed autonomously OR ask only when genuinely uncertain
4. Never output "run this command" and wait for user to copy-paste it

## Core Abstraction: Tracks

A **Track** is a bounded line of human intent that moves through explicit states.

```
Track = {
  id: string,           // Unique identifier
  intent: string,       // Human-readable goal
  state: TrackState,    // Current position in state machine
  plan_path: string,    // Path to PLAN.md (source of truth)
  beads_snapshot: {},   // Last-known beads state (read-only)
  created: timestamp,
  updated: timestamp
}
```

---

## 1. Track State Machine

Derived from GSD analysis, simplified for determinism.

### States

| State | Description | Entry | Exit |
|-------|-------------|-------|------|
| `draft` | Plan exists but not approved | tiller init | tiller approve |
| `approved` | Human approved, ready to execute | tiller approve | tiller activate |
| `active` | Work in progress | tiller activate | tiller checkpoint / tiller complete |
| `paused` | Human paused work | tiller pause | tiller resume |
| `checkpoint` | Awaiting human decision | auto (from active) | tiller decide |
| `complete` | Track finished | tiller complete | - |
| `abandoned` | Track abandoned | tiller abandon | - |

### State Transitions

```
           ┌──────────────────────────────────────┐
           │                                      │
           v                                      │
        [draft] ──approve──> [approved] ──activate──> [active]
           │                     │                      │
           │                     │                      ├──pause──> [paused]
           │                     │                      │              │
           │                     │                      │<──resume────┘
           │                     │                      │
           │                     │                      ├──checkpoint──> [checkpoint]
           │                     │                      │                    │
           │                     │                      │<────decide────────┘
           │                     │                      │
           │                     │                      └──complete──> [complete]
           │                     │
           └──abandon──> [abandoned] <──abandon────────┘
```

### Transition Rules

| From | To | Trigger | Human Required |
|------|-----|---------|----------------|
| draft | approved | `tiller approve` | Yes (confirmation) |
| draft | abandoned | `tiller abandon` | Yes (confirmation) |
| approved | active | `tiller activate` | Yes (command) |
| approved | abandoned | `tiller abandon` | Yes (confirmation) |
| active | paused | `tiller pause` | Yes (command) |
| active | checkpoint | auto (agent hits gate) | No |
| active | complete | `tiller complete` | Yes (confirmation) |
| active | abandoned | `tiller abandon` | Yes (confirmation) |
| paused | active | `tiller resume` | Yes (command) |
| checkpoint | active | `tiller decide <choice>` | Yes (decision) |

---

## 2. CLI Command Structure

### Core Commands

```bash
# Track lifecycle
tiller init <plan-path>           # Create track from PLAN.md
tiller approve [track-id]         # Approve track for execution
tiller activate [track-id]        # Begin execution
tiller pause [track-id]           # Pause active track
tiller resume [track-id]          # Resume paused track
tiller complete [track-id]        # Mark track complete
tiller abandon [track-id]         # Abandon track

# State queries
tiller status [track-id]          # Show track state + beads snapshot
tiller list [--state=<state>]     # List tracks by state
tiller show <track-id>            # Detailed track view

# Beads integration
tiller sync [track-id]            # Pull fresh beads snapshot
tiller diff [track-id]            # Show drift between intent and reality

# Decision handling
tiller decide <track-id> <choice> # Resolve checkpoint with decision
tiller checkpoints [track-id]     # List pending checkpoints
```

### Command Behavior

All commands:
- Read PLAN.md as source of truth
- Read beads via `bd` CLI (never write)
- Update local state file only
- Require explicit human action for state changes
- Print timestamped output

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Invalid state transition |
| 2 | Track not found |
| 3 | Beads sync failed |
| 4 | Human confirmation required |

---

## 3. File Formats

### Track State File

Location: `.tiller/tracks/<track-id>.json`

```json
{
  "id": "track-abc123",
  "intent": "Implement user authentication",
  "state": "active",
  "plan_path": ".planning/phases/01-foundation/01-01-PLAN.md",
  "created": "2026-01-15T10:00:00Z",
  "updated": "2026-01-15T12:30:00Z",
  "transitions": [
    {"from": "draft", "to": "approved", "at": "2026-01-15T10:05:00Z", "by": "human"},
    {"from": "approved", "to": "active", "at": "2026-01-15T10:10:00Z", "by": "human"}
  ],
  "checkpoints": [
    {"id": "cp-1", "type": "decision", "prompt": "Choose auth method", "resolved": null}
  ],
  "beads_snapshot": {
    "synced_at": "2026-01-15T12:25:00Z",
    "epic_id": "tiller-xyz",
    "tasks": [
      {"id": "tiller-xyz.1", "title": "Setup JWT", "status": "closed"},
      {"id": "tiller-xyz.2", "title": "Add middleware", "status": "in_progress"}
    ],
    "progress": {"closed": 1, "open": 2, "in_progress": 1}
  }
}
```

### Tiller Config

Location: `.tiller/config.json`

```json
{
  "version": "0.1.0",
  "default_plan_dir": ".planning/phases",
  "beads_cmd": "bd",
  "auto_sync_on_status": true,
  "confirmation_prompts": true
}
```

### Event Log

Location: `.tiller/events.jsonl`

```jsonl
{"ts":"2026-01-15T10:00:00Z","event":"track_created","track":"track-abc123","plan":".planning/phases/01-01-PLAN.md"}
{"ts":"2026-01-15T10:05:00Z","event":"state_change","track":"track-abc123","from":"draft","to":"approved"}
{"ts":"2026-01-15T10:10:00Z","event":"state_change","track":"track-abc123","from":"approved","to":"active"}
{"ts":"2026-01-15T12:25:00Z","event":"beads_sync","track":"track-abc123","epic":"tiller-xyz","progress":"1/4"}
```

---

## 4. Beads Integration Protocol

### Principle

**Tiller writes to beads on init, reads on sync.**

- `tiller init` creates beads epic + tasks with dependencies
- `tiller sync` pulls beads state into track snapshot
- Execution order determined by `bd ready` (dependency graph)

### Init Command (Write to BD)

```bash
tiller init <phase-dir>
# Example: tiller init .planning/phases/02-tiller-cli-core/
```

1. Scan phase directory for PLAN.md files
2. Create phase epic in beads: `bd create --type=epic --title="Phase 02: Tiller CLI Core"`
3. For each PLAN.md:
   - Create task: `bd create --type=task --parent=<epic> --title="02-01: Types + Storage"`
   - Create Track referencing the beads task
4. Import dependencies from PLAN.md `depends_on` frontmatter:
   - `bd dep add <task> <dependency>` for each dependency
5. Execution order is now determined by `bd ready --parent=<epic>`

**No wave calculation.** BD's dependency graph handles execution order.

### Sync Command (Read from BD)

```bash
tiller sync [track-id]
```

1. Read track's `plan_path`
2. Get beads task ID from track
3. Run `bd show <task-id> --json` to get current state
4. Store snapshot in track state file with timestamp
5. Print summary: "Synced at {time}: {closed}/{total} tasks complete"

### Snapshot Structure

```json
{
  "synced_at": "ISO timestamp",
  "epic_id": "from bd",
  "tasks": [
    {"id": "...", "title": "...", "status": "open|in_progress|closed"}
  ],
  "progress": {
    "closed": 2,
    "open": 1,
    "in_progress": 1
  },
  "blocked": ["task-id-1", "task-id-2"]
}
```

### Drift Detection

```bash
tiller diff [track-id]
```

Compares:
- PLAN.md tasks vs beads tasks (structural drift)
- Expected progress vs actual progress
- Outputs human-readable report

---

## 5. Human Decision Points

### Confirmation Prompts

Required for state transitions:

```
$ tiller approve track-abc123

Track: track-abc123
Intent: Implement user authentication
Plan: .planning/phases/01-foundation/01-01-PLAN.md

Tasks:
  1. Setup JWT utilities
  2. Add authentication middleware
  3. Create login endpoint

Approve this track for execution? [y/N]
```

### Checkpoint Resolution

When agent hits checkpoint:

```
$ tiller status track-abc123

Track: track-abc123
State: checkpoint
Checkpoint: cp-1 (decision)

Prompt: Choose authentication method

Options:
  1. JWT with refresh tokens
  2. Session-based auth
  3. OAuth2 only

Run: tiller decide track-abc123 <1|2|3>
```

### Decision Command

```bash
$ tiller decide track-abc123 1

Resolved checkpoint cp-1 with choice: "JWT with refresh tokens"
Track state: checkpoint → active
```

---

## 6. Dashboard Output

### tiller status

```
$ tiller status

HELM STATUS                           2026-01-15 12:30:00
═══════════════════════════════════════════════════════════

ACTIVE TRACKS
─────────────────────────────────────────────────────────
  track-abc123  [active]   Implement user auth    2/4 tasks
  track-def456  [paused]   Add payment flow       0/3 tasks

CHECKPOINTS PENDING
─────────────────────────────────────────────────────────
  track-abc123  cp-1  decision  "Choose auth method"

BEADS SNAPSHOT (synced 5 min ago)
─────────────────────────────────────────────────────────
  Ready:    3 tasks
  Blocked:  2 tasks

Run `tiller sync` to refresh beads state.
```

### tiller show

```
$ tiller show track-abc123

TRACK: track-abc123
═══════════════════════════════════════════════════════════
Intent:   Implement user authentication
State:    active
Plan:     .planning/phases/01-foundation/01-01-PLAN.md
Created:  2026-01-15 10:00:00
Updated:  2026-01-15 12:30:00

TRANSITIONS
─────────────────────────────────────────────────────────
  10:00  draft → approved (human)
  10:05  approved → active (human)

BEADS SNAPSHOT (synced 12:25)
─────────────────────────────────────────────────────────
  Epic: tiller-xyz
  Progress: ██████░░░░ 50% (2/4)

  ✓ tiller-xyz.1  Setup JWT utilities
  → tiller-xyz.2  Add auth middleware (in_progress)
  ○ tiller-xyz.3  Create login endpoint
  ○ tiller-xyz.4  Add logout endpoint

CHECKPOINTS
─────────────────────────────────────────────────────────
  cp-1  decision  "Choose auth method"  [PENDING]
```

---

## 7. Agent Integration

### How Agents Use Tiller

Agents query tiller for context:

```bash
# Agent checks current state
tiller status --json

# Agent gets track details
tiller show track-abc123 --json

# Agent syncs beads before work
tiller sync track-abc123
```

### Agent Workflow

1. Agent runs `tiller status --json` to find active track
2. Agent reads PLAN.md from track's `plan_path`
3. Agent queries beads via `bd ready` for available tasks
4. Agent works on task, updates beads via `bd update/close`
5. Agent runs `tiller sync` to update snapshot
6. If checkpoint hit, agent outputs structured return
7. Human runs `tiller decide` to resolve

### Checkpoint Return Format

When agent hits checkpoint, it outputs:

```json
{
  "type": "checkpoint",
  "track_id": "track-abc123",
  "checkpoint_id": "cp-1",
  "checkpoint_type": "decision",
  "prompt": "Choose authentication method",
  "options": [
    {"id": "1", "label": "JWT with refresh tokens", "description": "..."},
    {"id": "2", "label": "Session-based auth", "description": "..."}
  ],
  "completed_tasks": ["tiller-xyz.1"],
  "resume_point": "task-3"
}
```

---

## 8. Multi-Agent Observability

### The Problem

GSD subagents work invisibly - you can't see their shells or steer them easily. For manual multi-agent workflows (e.g., multiple Claude instances in tmux), we need observability.

### Agent Identity

Agents identify via environment variable (since `CLAUDE_SESSION_ID` isn't available):

```bash
# In each tmux pane, before starting Claude
export TILLER_AGENT=emma
export TILLER_AGENT=frank
export TILLER_AGENT=grace
```

### Agent Status Files

Each agent maintains a status file:

Location: `.tiller/agents/<name>.status.json`

```json
{
  "agent": "emma",
  "state": "working",
  "track_id": "track-abc123",
  "current_task": "Task 3: Implement track persistence",
  "message": "Writing save/load functions",
  "registered": "2026-01-15T10:00:00Z",
  "updated": "2026-01-15T10:30:00Z",
  "heartbeat": "2026-01-15T10:30:00Z"
}
```

### Agent States

| State | Description |
|-------|-------------|
| `idle` | Agent ready for work, no track claimed |
| `working` | Agent actively working on claimed track |
| `stuck` | Agent blocked, needs human input |
| `offline` | Agent unregistered or stale (no heartbeat) |

### Agent Commands

```bash
# Agent lifecycle
tiller agent register              # Register (reads $TILLER_AGENT)
tiller agent report <state> [msg]  # Report state with optional message
tiller agent heartbeat             # Prove liveness
tiller agent unregister            # Clean exit

# Orchestrator queries
tiller agents                      # List all agents
tiller agents --json               # JSON output
tiller status                      # Includes agents section
```

### Staleness Detection

Agents should send heartbeats periodically. If no heartbeat for >5 minutes, agent is marked stale:

```
$ tiller agents

AGENTS
──────────────────────────────────────────────────────────────────────
  NAME          STATE      TRACK           MESSAGE
──────────────────────────────────────────────────────────────────────
  emma          working    track-abc       "Implementing types..."
  frank         idle       -               -
  grace ⚠       stuck      track-def       "Need API decision"
──────────────────────────────────────────────────────────────────────
Total: 3 agent(s)

⚠ 1 stale agent(s) (no heartbeat >5min)
```

### Multi-Agent Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR (tmux pane 0)                                     │
│                                                                 │
│  $ watch -n5 tiller status                                      │
│                                                                 │
│  Sees: All agents, all tracks, progress, stuck agents           │
└─────────────────────────────────────────────────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ EMMA (pane 1)│ │FRANK (pane 2)│ │GRACE (pane 3)│
│              │ │              │ │              │
│ export       │ │ export       │ │ export       │
│ TILLER_AGENT │ │ TILLER_AGENT │ │ TILLER_AGENT │
│ =emma        │ │ =frank       │ │ =grace       │
│              │ │              │ │              │
│ claude       │ │ claude       │ │ claude       │
└──────────────┘ └──────────────┘ └──────────────┘
```

### Agent Startup Script

Each agent runs on startup:

```bash
# .claude/tiller-agent-init.sh (sourced by CLAUDE_ENV_FILE)
tiller agent register
echo "Agent $TILLER_AGENT registered"
```

### Integration with Track Claiming

When agent claims a track, status updates automatically:

```bash
# Agent claims track
tiller claim track-abc

# Agent status file updated:
# state: "working"
# track_id: "track-abc"
# message: "Claimed track-abc"
```

When agent releases track:

```bash
tiller release track-abc

# Agent status file updated:
# state: "idle"
# track_id: null
```

---

## 9. Implementation Notes

### Technology

- **Language**: TypeScript (Bun runtime)
- **Storage**: JSON files in `.tiller/`
- **Beads integration**: Shell out to `bd` CLI
- **No database**: File-based for simplicity

### Directory Structure

```
src/tiller/
├── index.ts           # CLI entry point
├── commands/
│   ├── init.ts
│   ├── approve.ts
│   ├── activate.ts
│   ├── status.ts
│   ├── sync.ts
│   └── decide.ts
├── state/
│   ├── track.ts       # Track state management
│   ├── events.ts      # Event logging
│   └── config.ts      # Config handling
├── beads/
│   ├── sync.ts        # Beads snapshot
│   └── diff.ts        # Drift detection
└── types/
    └── index.ts       # TypeScript types
```

### Claude Code Plugin

Thin adapter that invokes CLI:

```json
{
  "name": "tiller",
  "skills": "./skills/",
  "hooks": {}
}
```

Skills call `tiller` CLI commands directly.

---

## 10. Design Principles Checklist

- [x] **Deterministic behavior** - State machine with explicit transitions
- [x] **Low token usage** - JSON state files, not markdown parsing
- [x] **Explicit state** - Track state visible via `tiller status`
- [x] **Calm CLI semantics** - Simple commands, clear output
- [x] **Human-in-the-loop** - Confirmation prompts, decision points
- [x] **If unclear: stop** - Checkpoint system halts for human input

---

## 11. Migration from GSD

### Key Changes from GSD

| GSD | Tiller |
|-----|--------|
| Wave-based execution order | BD dependency graph (`bd ready`) |
| Subagent orchestration (invisible) | Multi-agent observability (visible) |
| STATE.md markdown sections | CLI API + JSON state |
| Read-only beads | Write on init, read on sync |

### Coexistence Period

During transition:
1. GSD PLAN.md files remain source of truth
2. Tiller imports plans to beads with dependencies
3. Execution order determined by `bd ready` (not waves)
4. Tiller provides explicit state layer + agent observability

### Migration Path

```
Phase 1: tiller init imports PLAN.md → beads epic + tasks + deps
Phase 2: tiller sync pulls beads state into track snapshots
Phase 3: Agents use tiller ready + bd ready for work discovery
Phase 4: GSD execute-phase replaced by tiller orchestration
```

---

## Summary

Tiller is an **explicit state tracking layer** that:

1. **Owns intent**: PLAN.md as source of truth
2. **Imports to beads**: `tiller init` creates epic + tasks with dependencies
3. **Reflects reality**: Sync pulls beads state into track snapshots
4. **Controls transitions**: Human-confirmed state changes
5. **Enables agents**: JSON queries for state, `bd ready` for work discovery
6. **Preserves history**: Event log for audit
7. **Multi-agent observability**: Agent status files for tmux workflows

Tiller does NOT:
- Execute tasks (agents do via `bd update/close`)
- Compute execution order (BD dependencies handle this via `bd ready`)
- Make autonomous decisions
- Guess or auto-update state
