# Ahoy Design Specification

> [!CAUTION]
> **This document describes an unimplemented architecture.** The design was superseded
> by ADR-0005 (Demand vs Supply Separation). Current implementation uses flat `specs/`
> with draft lifecycle (`ahoy draft/number/lock`). See `src/ahoy/` for actual commands.

**Version:** 0.2.0-draft
**Date:** 2026-01-15
**Status:** Design Phase

## Overview

Ahoy is a CLI for pre-implementation intent shaping. It handles all planning, research, and discovery work that precedes execution. Ahoy shapes intent but never executes, locks, or advances authoritative state.

### Standalone Operation

**Ahoy has no runtime dependencies on tiller or beads.** It is a pure planning tool that produces standard PLAN.md files.

Users can execute plans with:
- **tiller** — full execution custody with beads integration (recommended)
- **GSD commands** — via symlink hack (legacy compatibility)
- **Manual execution** — read PLAN.md, implement tasks yourself

### Multi-Initiative Support

Ahoy supports multiple initiatives (projects/workstreams) within a single repository. Each initiative is fully isolated and portable.

```
specs/
├── tiller/           # initiative 1
│   ├── PROJECT.md
│   ├── ROADMAP.md
│   ├── STATE.md
│   └── phases/
├── ace/              # initiative 2
│   ├── PROJECT.md
│   ├── ROADMAP.md
│   ├── STATE.md
│   └── phases/
└── shared/           # optional shared docs
    └── ARCHITECTURE.md
```

## Core Principles

### 1. Intent, Not Execution
Ahoy produces specifications that describe WHAT should happen. It never performs the work itself.

### 2. Human-First Output
All artifacts are designed for human readability. Markdown with YAML frontmatter. Git-tracked. Editable.

### 3. No Authority
Ahoy has no authority over execution state. It cannot create tracks, claim work, or mark things complete. That authority belongs exclusively to tiller.

### 4. Convention Over Configuration
`specs/{initiative}/` is THE structure. No flags, no alternatives.

### 5. Initiative Isolation
Each initiative is self-contained. Can be copied, moved, or deleted independently.

---

## Command Structure

```
ahoy
├── init <initiative>         Create new initiative
│
├── project
│   └── init <initiative>     Alias for 'ahoy init'
│
├── codebase
│   ├── map <initiative>      Parallel agents analyze codebase
│   └── refresh <initiative>  Update existing analysis
│
├── milestone
│   ├── create <initiative>   Define new milestone with phases
│   ├── discuss <initiative>  Interactive context gathering
│   └── list [initiative]     Show milestones
│
├── phase
│   ├── plan <initiative> <N>       Create PLAN.md files for phase N
│   ├── discuss <initiative> <N>    Interactive context gathering
│   └── assumptions <initiative> <N> Surface Claude's assumptions
│
├── discovery <initiative> <N>   Quick research (Level 1-2)
├── research <initiative> <N>    Deep ecosystem research (Level 3)
│
├── debug
│   ├── <initiative> [slug]      Start/resume debug session
│   └── list [initiative]        Show active sessions
│
├── status [initiative]          Show initiative state
└── list                         List all initiatives
```

### Initiative Argument

Most commands require an initiative:

```bash
# Explicit initiative
ahoy phase plan tiller 4
ahoy status ace

# List all initiatives
ahoy list
```

### Working Directory Shortcut

If current directory is within an initiative, it can be omitted:

```bash
cd specs/tiller
ahoy phase plan 4      # initiative=tiller inferred
ahoy status            # shows tiller status
```

---

## Directory Structure

### Per-Initiative Isolation

```
specs/
└── {initiative}/
    ├── PROJECT.md            # Initiative definition
    ├── ROADMAP.md            # Phase structure, milestones
    ├── STATE.md              # Split: Proposed / Authoritative
    ├── codebase/             # Codebase analysis (optional)
    │   ├── STACK.md
    │   ├── ARCHITECTURE.md
    │   └── ...
    ├── debug/                # Debug sessions
    │   └── {slug}.md
    └── phases/
        └── XX-name/
            ├── XX-YY-PLAN.md     # ahoy creates
            ├── XX-YY-SUMMARY.md  # tiller creates
            ├── XX-CONTEXT.md     # ahoy creates
            └── XX-RESEARCH.md    # ahoy creates
```

### Ahoy Ownership

| Path | Owner | Notes |
|------|-------|-------|
| `specs/{initiative}/PROJECT.md` | ahoy | Create/update |
| `specs/{initiative}/ROADMAP.md` | ahoy | Structure; tiller updates Progress |
| `specs/{initiative}/STATE.md#Proposed` | ahoy | Read/write |
| `specs/{initiative}/STATE.md#Authoritative` | tiller | Read-only for ahoy |
| `specs/{initiative}/codebase/` | ahoy | Exclusive |
| `specs/{initiative}/debug/` | ahoy | Exclusive |
| `specs/{initiative}/phases/*-PLAN.md` | ahoy | Create |
| `specs/{initiative}/phases/*-SUMMARY.md` | tiller | Read-only for ahoy |
| `specs/{initiative}/phases/*-CONTEXT.md` | ahoy | Exclusive |
| `specs/{initiative}/phases/*-RESEARCH.md` | ahoy | Exclusive |

### Ahoy MUST NOT Touch

- `.tiller/` — tiller's exclusive domain
- `.beads/` — beads' exclusive domain
- Any path outside `specs/`

---

## Command Specifications

### `ahoy init <initiative>`

Creates a new initiative with initial structure.

**Usage:**
```bash
ahoy init tiller
ahoy init ace
ahoy init my-feature
```

**Behavior:**
1. Create `specs/{initiative}/` directory
2. Interactive: gather project name, description, core value
3. Detect domain expertise (optional)
4. Generate `PROJECT.md` from template
5. Generate initial `ROADMAP.md` structure
6. Generate `STATE.md` with empty Proposed/Authoritative sections

**Output:**
```
specs/{initiative}/
├── PROJECT.md
├── ROADMAP.md
└── STATE.md
```

**Constraints:**
- Initiative name must be valid directory name (lowercase, hyphens OK)
- MUST NOT create `.tiller/`
- MUST NOT create tracks

---

### `ahoy codebase map <initiative>`

Orchestrates parallel agents to analyze codebase for an initiative.

**Usage:**
```bash
ahoy codebase map tiller
```

**Output:**
```
specs/{initiative}/codebase/
├── STACK.md
├── ARCHITECTURE.md
├── CONVENTIONS.md
├── TESTING.md
├── INTEGRATIONS.md
└── CONCERNS.md
```

---

### `ahoy phase plan <initiative> <N>`

Creates executable PLAN.md files for a phase.

**Usage:**
```bash
ahoy phase plan tiller 4
ahoy phase plan ace 6
```

**Behavior:**
1. Read `specs/{initiative}/ROADMAP.md` to find phase N
2. Read `specs/{initiative}/STATE.md#Proposed` for context
3. Check for existing CONTEXT.md, RESEARCH.md
4. Perform mandatory discovery (Level 0-3)
5. Break phase into tasks
6. Build dependency graph, assign waves
7. Generate PLAN.md file(s)
8. Update `specs/{initiative}/STATE.md#Proposed`

**Output:**
```
specs/{initiative}/phases/NN-name/
├── NN-01-PLAN.md
├── NN-02-PLAN.md
└── ...
```

---

### `ahoy status [initiative]`

Display initiative state.

**Usage:**
```bash
ahoy status tiller    # specific initiative
ahoy status           # current directory's initiative
ahoy list             # all initiatives
```

**Behavior:**
1. Read `specs/{initiative}/STATE.md`
2. Display both Proposed and Authoritative sections
3. Show delta (what's planned vs what's done)

---

### `ahoy list`

List all initiatives in the repository.

**Usage:**
```bash
ahoy list
```

**Output:**
```
Initiatives:
  tiller     Phase 4 of 5   [active]
  ace        Phase 1 of 11  [planning]
  feature-x  Phase 2 of 3   [complete]
```

---

## STATE.md Protocol

### Per-Initiative State

Each initiative has its own STATE.md:

```markdown
# Initiative State: tiller

## Proposed
<!-- ahoy: read/write -->
Current focus: Phase 4 - Tiller Testing
Planned phases: 5
Next milestone: v1.0
Planning status: Phase 4 planned (3 plans)

## Authoritative
<!-- tiller: read/write, ahoy: read-only -->
Last completed: Phase 3.5 Plan 02
Active tracks: 0
Completed tracks: 15
Last execution: 2026-01-15T12:54:09Z
```

### Rules

1. Ahoy MUST NOT write to `## Authoritative`
2. Ahoy MAY read Authoritative for status display
3. Each initiative's STATE.md is independent

---

## GSD Legacy Compatibility

For users who need GSD command compatibility:

```bash
# Symlink active initiative to .planning
ln -s specs/tiller .planning

# GSD commands now work
/gsd:execute-plan    # reads .planning/phases/...
/gsd:verify-work     # reads .planning/phases/...
```

**Note:** This is a documented hack, not a supported feature. Users should migrate to tiller for execution.

---

## Integration with Tiller

### Handoff Point

The handoff from ahoy to tiller is the PLAN.md file:

```
ahoy phase plan tiller 4
  ↓ creates
specs/tiller/phases/04-testing/04-01-PLAN.md
  ↓ user runs
tiller init specs/tiller/phases/04-testing/04-01-PLAN.md
  ↓ creates
.tiller/tracks/tiller--04-01.json
```

### Track Naming Convention

Tiller creates tracks with initiative prefix:

```
{initiative}--{phase}-{plan}

tiller--04-01    # initiative=tiller, phase=04, plan=01
ace--06-02       # initiative=ace, phase=06, plan=02
```

### No Direct Communication

- Ahoy does not call tiller
- Tiller does not call ahoy
- Communication is via files only
- PLAN.md is the API

---

## Anti-Patterns

### NEVER Do These

```bash
# Creating tiller state
ahoy init tiller
mkdir .tiller           # WRONG - ahoy must not create .tiller

# Executing code
ahoy phase plan tiller 4
npm run build           # WRONG - ahoy must not execute

# Cross-initiative state
ahoy status             # from specs/tiller, modifies specs/ace
                        # WRONG - initiatives are isolated

# Modifying authoritative state
ahoy status --mark-complete   # WRONG - no such flag exists
```

---

## Context Output Format (TOON)

Ahoy uses TOON (Token-Oriented Object Notation) for context serialization:

```bash
ahoy phase prime <initiative> <N>
```

**Output format:**
- TOON with 2-space indent, tab delimiter, key folding enabled
- Uniform arrays for phases, summaries, source files
- ~12% character reduction vs JSON, better tokenization

**For agent consumption (sandwich pattern):**

Per TOON docs, bidirectional prompts benefit from wrapping:

```
Data is in TOON format (2-space indent, arrays show length and fields).

```toon
[context data]
```

[task instruction]
```

Use `--prompt <task>` flag (future) to generate wrapped output for direct agent injection.

---

## Success Criteria

Ahoy is complete when it can:

1. ✅ Create new initiatives (`init`)
2. ✅ Map codebases (`codebase map`)
3. ✅ Manage milestones (`milestone create/discuss`)
4. ✅ Plan phases (`phase plan/discuss/assumptions`)
5. ✅ Perform research (`discovery`, `research`)
6. ✅ Track debug sessions (`debug`)
7. ✅ Display status (`status`, `list`)

All without:
- Creating `.tiller/`
- Executing code
- Modifying authoritative state
- Cross-initiative state mutation

---

*Version: 0.2.0-draft*
*Date: 2026-01-15*
*Author: Claude*
