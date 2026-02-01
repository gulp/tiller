# GSD ↔ Tiller Workflow Mapping

> [!NOTE]
> **Historical reference.** This document analyzes GSD (the predecessor system) to
> inform Tiller's design. GSD is no longer actively used.

**Date:** 2026-01-15
**Purpose:** Show how GSD workflows map to Tiller states and commands.

## Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        GSD → TILLER MAPPING                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  GSD WORKFLOW                TILLER STATE          BD INTEGRATION       │
│  ════════════                ════════════          ══════════════       │
│                                                                         │
│  ┌─────────────────┐                                                    │
│  │ discuss-phase   │────────────────────────────────────────────┐       │
│  │ research-phase  │  (context gathering, no track yet)         │       │
│  └────────┬────────┘                                            │       │
│           │                                                     │       │
│           ▼                                                     │       │
│  ┌─────────────────┐     ┌─────────────┐                        │       │
│  │   plan-phase    │────>│  proposed   │  PLAN.md created       │       │
│  └────────┬────────┘     └──────┬──────┘  Track created         │       │
│           │                     │                               │       │
│           │ (human reviews)     │ tiller approve                │       │
│           ▼                     ▼                               │       │
│  ┌─────────────────┐     ┌─────────────┐                        │       │
│  │  (human review) │────>│  approved   │  Intent agreed         │       │
│  └────────┬────────┘     └──────┬──────┘  FR/NFR/AC confirmed   │       │
│           │                     │                               │       │
│           │                     │ tiller import                 │       │
│           ▼                     ▼                               │       │
│  ┌─────────────────┐     ┌─────────────┐     ┌──────────────┐  │       │
│  │    ptb/init     │────>│    ready    │────>│ BD issues    │  │       │
│  └────────┬────────┘     └──────┬──────┘     │ created      │  │       │
│           │                     │             │ with deps    │  │       │
│           │                     │ tiller      └──────────────┘  │       │
│           │                     │ activate                      │       │
│           ▼                     ▼                               │       │
│  ┌─────────────────┐     ┌─────────────┐     ┌──────────────┐  │       │
│  │  execute-plan   │────>│   active    │<───>│ bd ready     │  │       │
│  │  execute-phase  │     └──────┬──────┘     │ bd show      │  │       │
│  └────────┬────────┘            │             │ bd close     │  │       │
│           │                     │             └──────────────┘  │       │
│           │ (pause)             │ tiller pause                  │       │
│           ▼                     ▼                               │       │
│  ┌─────────────────┐     ┌─────────────┐                        │       │
│  │   pause-work    │────>│   paused    │  Context saved         │       │
│  │   resume-work   │<────│             │                        │       │
│  └────────┬────────┘     └──────┬──────┘                        │       │
│           │                     │ tiller resume                 │       │
│           │                     ▼                               │       │
│           │              ┌─────────────┐                        │       │
│           └─────────────>│   active    │  (continues)           │       │
│                          └──────┬──────┘                        │       │
│                                 │                               │       │
│                                 │ (all BD issues closed)        │       │
│                                 │ tiller verify                 │       │
│                                 ▼                               │       │
│  ┌─────────────────┐     ┌─────────────┐                        │       │
│  │   verify-work   │────>│  verifying  │  Human checks          │       │
│  └────────┬────────┘     └──────┬──────┘                        │       │
│           │                     │                               │       │
│           │ (pass)              │ tiller complete               │       │
│           ▼                     ▼                               │       │
│  ┌─────────────────┐     ┌─────────────┐                        │       │
│  │  SUMMARY.md     │────>│  complete   │  Track done            │       │
│  │  written        │     └─────────────┘                        │       │
│  └─────────────────┘                                            │       │
│                                 │                               │       │
│           │ (fail)              │ tiller rework                 │       │
│           ▼                     ▼                               │       │
│  ┌─────────────────┐     ┌─────────────┐                        │       │
│  │  plan-fix       │────>│   active    │  Back to work          │       │
│  └─────────────────┘     └─────────────┘                        │       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Detailed Command Mapping

### Pre-Planning (No Track Yet)

| GSD Command | Tiller Equivalent | Description |
|-------------|-------------------|-------------|
| `/gsd:new-project` | - | Creates PROJECT.md, ROADMAP.md |
| `/gsd:create-roadmap` | - | Creates ROADMAP.md with phases |
| `/gsd:discuss-phase N` | - | Gathers context, creates CONTEXT.md |
| `/gsd:research-phase N` | - | Deep research, creates RESEARCH.md |
| `/gsd:list-phase-assumptions N` | - | Lists Claude's assumptions |

**Tiller role:** None. These are pre-planning activities.

### Planning Phase

| GSD Command | Tiller State | Tiller Command | BD Action |
|-------------|--------------|----------------|-----------|
| `/gsd:plan-phase N` | → `proposed` | `tiller init` | None |
| (human review) | `proposed` → `approved` | `tiller approve` | None |
| `ptb <plan>` | `approved` → `ready` | `tiller import` | `bd create` + deps |

**New flow with Tiller:**
```bash
# 1. Plan phase creates lean PLAN.md + track
/gsd:plan-phase 2
# Track state: proposed

# 2. Human reviews intent
tiller review track-abc
# Shows objective, criteria for review

# 3. Human approves
tiller approve track-abc
# Track state: approved

# 4. Import creates BD issues
tiller import track-abc
# Creates BD epic/tasks with deps
# Track state: ready
```

### Execution Phase

| GSD Command | Tiller State | Tiller Command | BD Action |
|-------------|--------------|----------------|-----------|
| `/gsd:execute-plan <plan>` | `ready` → `active` | `tiller activate` | - |
| (agent working) | `active` | - | `bd ready`, `bd show`, `bd close` |
| `/gsd:pause-work` | `active` → `paused` | `tiller pause` | - |
| `/gsd:resume-work` | `paused` → `active` | `tiller resume` | - |

**Execution loop:**
```bash
# 1. Activate track
tiller activate track-abc
# Track state: active

# 2. Agent execution loop
while true; do
  # Find next task
  TASK=$(bd ready --parent=$EPIC_ID --limit=1 --json | jq -r '.[0].id')
  [ -z "$TASK" ] && break

  # Get task details
  bd show $TASK

  # Work on task...
  bd update $TASK --status=in_progress

  # Complete task
  bd close $TASK
done

# 3. All tasks done → verify
tiller verify track-abc
```

### Verification & Completion

| GSD Command | Tiller State | Tiller Command | BD Action |
|-------------|--------------|----------------|-----------|
| `/gsd:verify-work` | `active` → `verifying` | `tiller verify` | Check all closed |
| (verification passes) | `verifying` → `complete` | `tiller complete` | - |
| (verification fails) | `verifying` → `active` | `tiller rework` | New issues created |
| `/gsd:plan-fix` | `active` | - | `bd create` for fixes |

**Verification flow:**
```bash
# 1. Verify against criteria
tiller verify track-abc
# Shows success_criteria, asks human to confirm
# Track state: verifying

# 2a. If pass → complete
tiller complete track-abc
# Agent writes SUMMARY.md
# Track state: complete

# 2b. If fail → rework
tiller rework track-abc
# Track state: active
# Human/agent creates new BD issues for fixes
```

### Phase-Level Operations

| GSD Command | Tiller Equivalent | Description |
|-------------|-------------------|-------------|
| `/gsd:execute-phase N` | `tiller activate-phase N` | Activates all ready tracks in phase |
| `/gsd:progress` | `tiller status` | Shows phase/track progress |

**Phase execution with Tiller:**
```bash
# Option A: Sequential (manual)
tiller activate track-02-01
# ... work ...
tiller verify track-02-01
tiller complete track-02-01

tiller activate track-02-02
# ... etc

# Option B: Parallel (orchestrated)
tiller activate-phase 2
# Activates all tracks where deps are met
# Agent works on bd ready tasks across tracks
```

## State Machine Comparison

### Current GSD (Implicit States)

```
PLAN.md exists → executing → SUMMARY.md exists
     │              │              │
     │              │              │
   (draft)      (in_progress)  (complete)
```

GSD doesn't have explicit states - inferred from file existence.

### Tiller (Explicit States)

```
proposed → approved → ready → active → verifying → complete
    │          │         │       │          │
    └──────────┴─────────┴───────┴──────────┴──→ abandoned
                                 │
                             paused ←──→ active
```

Every state is explicit, queryable via `tiller status`.

## Migration: GSD Commands → Tiller

### Phase 1: Coexistence

GSD commands work alongside Tiller. Tiller adds explicit state tracking.

```bash
# Old way (still works)
/gsd:plan-phase 2
/gsd:execute-plan .planning/phases/02-*/02-01-PLAN.md

# New way (with Tiller)
/gsd:plan-phase 2           # Creates PLAN.md + track (proposed)
tiller approve track-abc    # Human approves
tiller import track-abc     # Creates BD issues
tiller activate track-abc   # Begin execution
# ... work via bd ready/show/close ...
tiller verify track-abc     # Check criteria
tiller complete track-abc   # Write SUMMARY.md
```

### Phase 2: GSD Wraps Tiller

GSD commands become thin wrappers around Tiller.

```bash
/gsd:plan-phase 2
# Internally: creates PLAN.md, runs tiller init

/gsd:execute-plan <plan>
# Internally: tiller import → tiller activate → execution loop
```

### Phase 3: Tiller Primary

Tiller CLI becomes primary interface. GSD skills invoke Tiller.

```bash
tiller plan 2           # Creates lean PLAN.md, track in proposed
tiller approve          # Human approves intent
tiller import           # Creates BD issues
tiller activate         # Begin work
tiller verify           # Check criteria
tiller complete         # Write summary
```

## Summary Table

| Lifecycle Stage | GSD Command | Tiller State | Tiller Command | BD |
|-----------------|-------------|--------------|----------------|----|
| Context | discuss-phase | - | - | - |
| Research | research-phase | - | - | - |
| Planning | plan-phase | `proposed` | init | - |
| Review | (manual) | `proposed` | review | - |
| Approval | (manual) | `approved` | approve | - |
| Import | ptb | `ready` | import | create + deps |
| Execution | execute-plan | `active` | activate | ready/show/close |
| Pause | pause-work | `paused` | pause | - |
| Resume | resume-work | `active` | resume | - |
| Verify | verify-work | `verifying` | verify | check closed |
| Complete | (SUMMARY.md) | `complete` | complete | - |
| Rework | plan-fix | `active` | rework | create fixes |
| Abandon | (manual) | `abandoned` | abandon | close/orphan |

---

*Mapping completed: 2026-01-15*
