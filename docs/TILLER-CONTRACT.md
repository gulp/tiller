# Tiller Contract Specification

> [!CAUTION]
> **This document has significant drift from the implementation.** Key issues:
> - Directory structure uses `plans/{initiative}/` not `specs/{initiative}/phases/` for execution
> - Configuration is `tiller.toml` (TOML), not `config.json`
> - PLAN.md validation described here is not implemented; `tiller init` does basic checks only
> - Many commands are undocumented here (40+ commands exist vs ~10 documented)
> - State machine is HSM with slash notation — see `src/tiller/types/index.ts`
> - `tiller start` (collapsed init+activate) is the primary command, not mentioned here
>
> **Source of truth:** `tiller --help`, `src/tiller/commands/`, `src/tiller/types/index.ts`

**Version:** 0.2.0-draft
**Date:** 2026-01-15
**Status:** Design Phase (partially implemented)

## Overview

This document defines the contract between **ahoy** (intent shaping) and **tiller** (execution custody). The contract specifies directory ownership, file schemas, and interaction rules.

## Core Contract

### Authority Separation

| Domain | Owner | Authority |
|--------|-------|-----------|
| Intent specification | ahoy | Creates plans, research, context per initiative |
| Execution state | tiller | Runs, claims, completions (global) |
| `specs/{initiative}/` | ahoy (primary) | tiller writes SUMMARY.md only |
| `.tiller/` directory | tiller (exclusive) | ahoy has no access |

### The Rule

```
ahoy  shapes intent  → specs/{initiative}/
tiller executes      → .tiller/
tiller reports       → specs/{initiative}/phases/*-SUMMARY.md
```

---

## Directory Structure

### Multi-Initiative Layout

```
specs/                              # Human-first, git-tracked
├── tiller/                        # Initiative 1
│   ├── PROJECT.md                 # [ahoy] Initiative definition
│   ├── ROADMAP.md                 # [ahoy/tiller] Phase structure
│   ├── STATE.md                   # [ahoy/tiller] Split ownership
│   ├── codebase/                  # [ahoy] Analysis output
│   └── phases/
│       └── XX-name/
│           ├── XX-YY-PLAN.md      # [ahoy] Execution spec
│           ├── XX-YY-SUMMARY.md   # [tiller] Execution result
│           └── XX-YY-ISSUES.md    # [tiller] UAT issues
├── ace/                           # Initiative 2
│   ├── PROJECT.md
│   ├── ROADMAP.md
│   ├── STATE.md
│   └── phases/
└── shared/                        # Optional shared docs
    └── ARCHITECTURE.md

.tiller/                            # Machine-first, tiller exclusive
├── tiller.toml                    # Tiller configuration (TOML, see ADR-0009)
├── runs/                          # Run state (all initiatives)
│   ├── tiller--04-01.json
│   ├── tiller--04-02.json
│   └── ace--01-01.json
├── events.jsonl                   # Audit log (all initiatives)
├── hands/                         # Agent reservations
│   └── {hand-name}.json
├── workflows/                     # Workflow instances
│   └── {instance-id}.json
└── constitutional/                # Knowledge injection (additive)
    ├── 01-test-integrity.md
    └── 02-verification.md
```

### Key Design: Global .tiller/

A single `.tiller/` at repo root manages runs for ALL initiatives. This enables:
- Cross-initiative coordination (hands, claiming)
- Unified event log and audit trail
- Single `tiller status` shows all work
- No initiative isolation at execution level

### Constitutional Knowledge Injection

`.tiller/constitutional/` contains markdown files output to stdout on `tiller activate`.

**Design: Additive, not override.**
- Add files to inject new knowledge
- Remove files to stop injecting
- User controls content entirely
- Contrast: `.beads/PRIME.md` **replaces** default entirely

**Injection point:** `tiller activate` (execution start)
- Deterministic: agent runs command, sees stdout
- Not hooks (unreliable), not @-references (requires expansion)

---

## Run Naming Convention

### Format: `{initiative}--{phase}-{plan}`

Double-dash (`--`) separates initiative from phase-plan:

```
tiller--04-01      # initiative=tiller, phase=04, plan=01
tiller--04-02      # initiative=tiller, phase=04, plan=02
ace--06-01         # initiative=ace, phase=06, plan=01
ace--06.1-01       # initiative=ace, phase=06.1 (decimal), plan=01
```

### Parsing

```typescript
function parseRunId(runId: string): RunInfo {
  const [initiative, phasePlan] = runId.split('--');
  const lastDash = phasePlan.lastIndexOf('-');
  const phase = phasePlan.slice(0, lastDash);
  const plan = phasePlan.slice(lastDash + 1);
  return { initiative, phase, plan };
}

// tiller--04-01 → { initiative: "tiller", phase: "04", plan: "01" }
// ace--06.1-01  → { initiative: "ace", phase: "06.1", plan: "01" }
```

### Run File Location

```
.tiller/runs/{initiative}--{phase}-{plan}.json
```

---

## File Schemas

### PLAN.md (ahoy → tiller)

The PLAN.md file is the primary contract point. Tiller `init` validates this schema strictly.

**Location:** `specs/{initiative}/phases/XX-name/XX-YY-PLAN.md`

```yaml
---
# REQUIRED - tiller init rejects if missing/invalid
phase: string           # Format: "XX-name" (e.g., "04-tiller-testing")
plan: string            # Format: "NN" (e.g., "01", "02")
type: enum              # "execute" | "tdd"
wave: integer           # Execution wave (1, 2, 3...)
depends_on: string[]    # Plan IDs (e.g., ["04-01"])
files_modified: string[] # File paths this plan touches
autonomous: boolean     # false if plan has checkpoints

# OPTIONAL
domain: string          # Domain expertise loaded
---

<objective>
[What this plan accomplishes]
</objective>

<tasks>
<task type="auto">
  <name>[Task name]</name>
  <files>[File paths]</files>
  <action>[Implementation details]</action>
  <verify>[Verification command]</verify>
  <done>[Acceptance criteria]</done>
</task>
</tasks>

<verification>
[Overall verification checklist]
</verification>

<success_criteria>
[Measurable completion criteria]
</success_criteria>
```

### Initiative Derivation

Tiller derives initiative from PLAN.md path:

```
specs/tiller/phases/04-testing/04-01-PLAN.md
      ^^^^^^
      initiative = "tiller"
```

**Validation:** If path doesn't match `specs/{initiative}/phases/...`, reject.

---

### SUMMARY.md (tiller → ahoy)

Tiller produces SUMMARY.md after execution completes.

**Location:** `specs/{initiative}/phases/XX-name/XX-YY-SUMMARY.md`

```yaml
---
phase: string
plan: string
status: enum            # "complete" | "partial"
completed_at: string    # ISO8601 timestamp
epic_id: string         # Beads epic reference
initiative: string      # Initiative name

# Dependency graph
requires: string[]
provides: string[]
affects: string[]

# Tech tracking
tech-stack:
  added: string[]
  patterns: string[]

key-files:
  created: string[]
  modified: string[]

key-decisions: string[]
issues-created: string[]
duration: string
tasks_completed: string
---
```

---

### STATE.md (Split Ownership)

Each initiative has its own STATE.md with explicit section ownership.

**Location:** `specs/{initiative}/STATE.md`

```markdown
# Initiative State: {initiative}

## Proposed
<!-- Writer: ahoy | Reader: tiller -->
<!-- Contains: intent, plans, focus -->

**Current focus:** Phase 4 - Tiller Testing
**Planned phases:** 5
**Next milestone:** v1.0
**Planning status:** Phase 4 planned (3 plans)

### Planned Work
- Phase 4: 3 plans ready
- Phase 5: Not yet planned

## Authoritative
<!-- Writer: tiller | Reader: ahoy -->
<!-- Contains: actual state, completions, timestamps -->

**Last completed:** Phase 3.5 Plan 02
**Active runs:** 0
**Completed runs:** 15
**Last execution:** 2026-01-15T12:54:09Z

### Completed Phases
| Phase | Plans | Completed |
|-------|-------|-----------|
| 3.5 | 2/2 | 2026-01-15 |
```

**Rules:**
1. Section headers are immutable
2. ahoy MUST NOT write below `## Authoritative`
3. tiller MUST NOT write below `## Proposed`
4. Each initiative's STATE.md is independent

---

### ROADMAP.md (Split Ownership)

**Location:** `specs/{initiative}/ROADMAP.md`

```markdown
# Roadmap: {initiative}

## Overview
<!-- Writer: ahoy -->
[Initiative overview]

## Phases
<!-- Writer: ahoy -->
[Phase definitions]

## Progress
<!-- Writer: tiller -->
| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 3.5 | 2/2 | Complete | 2026-01-15 |
| 4 | 0/3 | In Progress | - |
```

---

## Ownership Matrix

### Per-Initiative Files

| Resource | ahoy | tiller |
|----------|------|--------|
| `specs/{init}/PROJECT.md` | R/W | R |
| `specs/{init}/ROADMAP.md` (Phases) | R/W | R |
| `specs/{init}/ROADMAP.md` (Progress) | R | R/W |
| `specs/{init}/STATE.md` (Proposed) | R/W | R |
| `specs/{init}/STATE.md` (Authoritative) | R | R/W |
| `specs/{init}/codebase/` | R/W | - |
| `specs/{init}/debug/` | R/W | - |
| `specs/{init}/phases/*-PLAN.md` | R/W | R |
| `specs/{init}/phases/*-SUMMARY.md` | R | R/W |
| `specs/{init}/phases/*-ISSUES.md` | R | R/W |
| `specs/{init}/phases/*-CONTEXT.md` | R/W | - |
| `specs/{init}/phases/*-RESEARCH.md` | R/W | - |

### Global Resources

| Resource | ahoy | tiller |
|----------|------|--------|
| `.tiller/` | - | R/W (exclusive) |
| `.beads/` | - | R (via bd) |

---

## Interaction Rules

### What Tiller Reads from `specs/`

| File | Section | Purpose |
|------|---------|---------|
| `{init}/phases/*-PLAN.md` | All | Import as run |
| `{init}/STATE.md` | Authoritative | Current position |
| `{init}/STATE.md` | Proposed | Context only |
| `{init}/ROADMAP.md` | Phases | Track context |
| `{init}/phases/*-SUMMARY.md` | All | Dependency context |

### What Tiller Writes to `specs/`

| File | Section | Trigger |
|------|---------|---------|
| `{init}/phases/*-SUMMARY.md` | All | `tiller complete` |
| `{init}/phases/*-ISSUES.md` | All | `tiller uat` |
| `{init}/STATE.md` | Authoritative | State transitions |
| `{init}/ROADMAP.md` | Progress | Phase completions |

### What Tiller MUST NOT Do

```
❌ Create PLAN.md
❌ Modify PLAN.md
❌ Write to STATE.md ## Proposed
❌ Write to ROADMAP.md ## Phases
❌ Create or modify specs/{init}/codebase/
❌ Create or modify specs/{init}/debug/
❌ Modify CONTEXT.md or RESEARCH.md
❌ Create new initiatives (directories under specs/)
```

---

## Validation Gate

### `tiller init` Validation

When `tiller init specs/{init}/phases/XX-name/XX-YY-PLAN.md` runs:

```
1. Parse path to extract initiative
2. Validate path matches specs/{init}/phases/* pattern
3. Parse YAML frontmatter
4. Validate required fields exist
5. Validate field types match schema
6. Validate phase matches directory name
7. Validate plan matches filename
8. Check depends_on references exist (warn if not)
9. Create run in .tiller/runs/{init}--{phase}-{plan}.json
10. Log event to .tiller/events.jsonl
```

**Rejection triggers:**
- Path doesn't match `specs/{initiative}/phases/**/*-PLAN.md`
- Missing required frontmatter field
- Invalid field type
- Malformed XML in body
- Missing `<tasks>` section

**Error format:**
```
tiller init: validation failed
  specs/tiller/phases/04-testing/04-01-PLAN.md

  errors:
    - frontmatter.wave: expected integer, got string
    - frontmatter.autonomous: missing required field

  hint: run 'ahoy phase plan tiller 4' to regenerate
```

---

## Event Flow

### Happy Path

```
1. ahoy init tiller
   → specs/tiller/ (created with PROJECT, ROADMAP, STATE)

2. ahoy phase plan tiller 4
   → specs/tiller/phases/04-testing/04-01-PLAN.md (created)
   → specs/tiller/STATE.md ## Proposed (updated)

3. tiller init specs/tiller/phases/04-testing/04-01-PLAN.md
   → .tiller/runs/tiller--04-01.json (created)
   → .tiller/events.jsonl (appended)

4. tiller activate tiller--04-01
   → .tiller/runs/tiller--04-01.json (state: active)

5. [execution happens]

6. tiller complete tiller--04-01
   → .tiller/runs/tiller--04-01.json (state: complete)
   → specs/tiller/phases/04-testing/04-01-SUMMARY.md (created)
   → specs/tiller/STATE.md ## Authoritative (updated)
   → specs/tiller/ROADMAP.md ## Progress (updated)
```

### Cross-Initiative Example

```
# Two initiatives, parallel work
ahoy init tiller
ahoy init ace

ahoy phase plan tiller 4
ahoy phase plan ace 1

tiller init specs/tiller/phases/04-testing/04-01-PLAN.md
tiller init specs/ace/phases/01-foundation/01-01-PLAN.md

# Both runs in single .tiller/
ls .tiller/runs/
  tiller--04-01.json
  ace--01-01.json

# Status shows all
tiller status
  tiller--04-01  active
  ace--01-01     active
```

---

## GSD Legacy Compatibility

For users needing GSD command compatibility:

```bash
# Symlink active initiative to .planning
ln -s specs/tiller .planning

# GSD commands work
/gsd:execute-plan
/gsd:verify-work
```

**Note:** Documented hack, not supported feature.

---

## Absorbed Components

### ptb (plan-to-beads) Plugin

**Status:** Deprecated after Phase 6 (Tiller Production)

| ptb Feature | Tiller Replacement | Phase |
|-------------|-------------------|-------|
| `ptb import` (plan → beads) | `tiller init` | 3 |
| `ptb sync-back` (STATE.md) | Contract writes to STATE.md Authoritative | 5 |
| `ptb todo` (todo → beads) | `tiller todo` or remains external | 5/6 |
| PostToolUse hook | Tiller plugin hooks | 6 |

**Migration:**
- Phase 5: tiller handles STATE.md writes, ptb sync-back becomes redundant
- Phase 6: tiller plugin replaces ptb hooks, ptb fully deprecated
- Phase 7+: Remove ptb from codebase

**Rationale:** Tiller is the execution custody layer. Plan→beads bridging and state synchronization are execution concerns, not separate plugin concerns.

### gsd-bd Plugin

**Status:** Already absorbed

The gsd-bd plugin (GSD↔beads bridge) was absorbed into tiller during Phase 3. Its `/gsd-bd:plan-to-beads` skill is superseded by `tiller init`.

---

## Hard Rules Summary

1. **ahoy never touches `.tiller/`**
2. **tiller never creates PLAN.md or initiatives**
3. **STATE.md sections have single writers**
4. **PLAN.md is the API**
5. **Run IDs include initiative prefix** (see ADR-0004)
6. **No runtime coupling (no imports, no IPC)**
7. **Each initiative is isolated in specs/, unified in .tiller/**

---

*Version: 0.2.0-draft*
*Date: 2026-01-15*
*Author: Claude*
