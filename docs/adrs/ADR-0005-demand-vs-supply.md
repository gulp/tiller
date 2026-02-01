# ADR-0005: Demand vs Supply Separation

## Status

Accepted (revised 2026-01-18)

## Context

We need a clear boundary between exploratory work (demand) and execution work (supply). This ADR defines folder structures, state machines, and the transition between them.

---

## 1. Core Principle

> **Demand side asks questions. Supply side answers them.**

| Side | Owns | Output | Character |
|------|------|--------|-----------|
| Demand (`specs/`) | Why, What | Proposals | Exploratory, non-linear, reversible |
| Supply (`plans/`) | How, When | Working artifacts | Linear, accountable, auditable |

---

## 2. Folder Structure

### Demand side: `specs/`

Flat, draft-by-default. IDs for identity, names for intent.

```
specs/
  auth-hardening/              # drafting (no number)
  api-refactor/                # drafting
  0001-dashboard/              # numbered (identity assigned, still draft)
  0002-auth-hardening/         # numbered
  0003-api-refactor.lock/      # committed (ready for/accepted by tiller)
```

**Rules:**
- Unnumbered folder = early drafting (chaos)
- Numbered folder = identity assigned, mature draft
- `.lock` suffix = committed to supply-side

**No initiative folders in specs.** Initiatives live only in `plans/`.

### Supply side: `plans/`

Structured by initiative, phase, and plan.

```
plans/
  ROADMAP.md                           # global: initiatives overview
  tiller-cli/                          # initiative
    STATUS.md                          # derived: phase states
    01-foundation/                     # phase
      01-01-PLAN.md                    # plan (phase.plan in filename)
      01-02-PLAN.md
      01-01-SUMMARY.md
    01.1-hotfix/                       # decimal phase (urgent insert)
      01.1-01-PLAN.md
    02-cli-core/
      02-01-PLAN.md
      02-02-PLAN.md
  auth-service/                        # another initiative
    STATUS.md
    01-infrastructure/
      01-01-PLAN.md
```

**Naming pattern:** `<phase>-<plan>-PLAN.md`
- Easy grep: `ls plans/tiller-cli/01*/*-PLAN.md`
- Hierarchy encoded in filename
- Decimals (`01.1`) for urgent insertions (no renumbering)

---

## 3. Draft Lifecycle (ahoy)

Drafts have their own lifecycle, separate from plans.

```
[unnumbered]  →  [numbered]  →  [.lock]
   chaos          identity      committed
```

**Draft folder contents:**
```
specs/0001-auth-hardening/
  scope.md           # problem statement
  research.md        # exploration notes
  contracts.md       # API contracts, data models
  PROPOSAL.md        # final proposal (optional, signals readiness)
```

**Key properties:**
- No runs, no tasks, no verification
- No SUMMARY.md, no phases
- Answers: "Is this worth executing?"

---

## 4. The Boundary Crossing

### `tiller accept` is the only crossing point

```bash
tiller accept 0003-api-refactor --as-initiative api --phases 3
```

**What it does (atomically):**
1. Renames `specs/0003-api-refactor/` → `specs/0003-api-refactor.lock/`
2. Creates initiative folder if needed: `plans/api/`
3. Scaffolds phase folders and plan stubs:
   ```
   plans/api/
     01-endpoints/01-01-PLAN.md
     02-middleware/02-01-PLAN.md
     03-testing/03-01-PLAN.md
   ```
4. Records provenance in each plan:
   ```yaml
   ---
   origin: specs/0003-api-refactor
   ---
   ```
5. Creates `plans/api/STATUS.md`

**After acceptance:**
- `specs/*.lock/` = immutable demand-side record
- `plans/` = tiller's territory
- ahoy no longer owns it

---

## 5. Plan Lifecycle (tiller)

```
drafted → approved → ready → active → verifying → complete
```

Plans live in `plans/<initiative>/<phase>/`.

**States:**
- `drafted` — plan stub exists, needs expansion
- `approved` — reviewed, ready to import
- `ready` — imported, can be activated
- `active` — execution in progress
- `verifying` — awaiting verification
- `complete` — done, has SUMMARY.md

---

## 6. Phase Rules

### Append by default
New phases go after the last one.

```
01-foundation
02-cli-core
03-new-feature   ← default: append
```

### Decimals for urgent inserts
When something must go *between* existing phases:

```
01-foundation
01.1-security-hotfix   ← urgent insert
02-cli-core
```

**Decimals signal:**
- Late discovery
- Should be rare
- No renumbering of existing phases

### Renumbering
Only via explicit commands (`tiller repair phases --reindex`), and only before runs exist.

---

## 7. ROADMAP Structure

### Global: `plans/ROADMAP.md`
```markdown
# Roadmap

## Initiatives

### tiller-cli [████████░░] 80%
Core CLI for intent state tracking.
Phases: 8/10 complete | Active: 06.6-ax-friction

### auth-service [██░░░░░░░░] 20%
Authentication microservice.
Phases: 2/10 complete | Active: 03-oauth
```

- Human-authored descriptions
- Derived progress bars and counts
- Cross-initiative visibility

### Per-initiative: `plans/<initiative>/STATUS.md`
```markdown
# tiller-cli Status

Generated: 2026-01-18T12:00:00Z

| Phase | Status | Progress |
|-------|--------|----------|
| 01-foundation | complete | 2/2 |
| 02-cli-core | complete | 5/5 |
| 06.6-ax-friction | active | 3/10 |
```

- Fully derived from `.tiller/runs/`
- Regenerated by `tiller status --write`

---

## 8. Discovery

```bash
# Drafts (still in chaos)
ls specs/*/ | grep -v '.lock'

# Committed (ready for/accepted by tiller)
ls -d specs/*.lock/

# All plans in an initiative
ls plans/tiller-cli/*/*-PLAN.md

# Plans in a specific phase
ls plans/tiller-cli/01*/*-PLAN.md
```

---

## 9. Command Summary

### ahoy (demand-side)
```bash
ahoy draft auth-hardening       # create unnumbered folder
ahoy number auth-hardening      # assign ID → 0004-auth-hardening
# drafting happens manually or via ahoy subcommands
```

### tiller (supply-side)
```bash
tiller accept 0004-auth-hardening --as-initiative auth
tiller start 01-01              # begin execution
tiller verify 01-01             # verification gate
tiller run complete 01-01       # mark done
```

---

## 10. One-Page Mental Model

> Drafts explore.
> Proposals negotiate.
> `.lock` commits.
> Plans execute.
> Summaries remember.

```
specs/                          plans/
├── auth-idea/                  ├── ROADMAP.md
├── 0001-dashboard/             ├── tiller-cli/
├── 0002-auth.lock/  ──────────►│   ├── STATUS.md
                                │   ├── 01-foundation/
                                │   │   ├── 01-01-PLAN.md
                                │   │   └── 01-01-SUMMARY.md
```

---

## 11. Invariants

1. **No plans in `specs/`** — only drafts and proposals
2. **No drafts in `plans/`** — only executable plans
3. **`.lock` is irreversible** — once committed, folder stays locked
4. **Execution history is immutable** — runs cannot be rewritten
5. **One crossing point** — only `tiller accept` moves work to supply

---

## 12. Doctrine

> **Ahoy asks. Tiller commits.**

If a file or command doesn't fit this sentence, it's in the wrong place.
