# ADR-0004: Transition from Tracks to Runs

**Status:** Accepted
**Date:** 2026-01-17

## Implementation Phases

### Phase 1: Terminology + TOON Output (Current)

**Approach:** `plan_ref` serves as the effective run identifier.

- TOON output uses `run:` key (not `track:`)
- 1:1 mapping: one plan = one run (implicitly)
- Internal JSON files retain `track-*.json` naming and `id` field
- No separate `run_id` generation

**Rationale:** Simpler implementation. The 1:1 constraint holds for current workflows.
Renaming internal JSON fields provides no user-visible benefit until multi-run is needed.

### Phase 2: Full Run Separation (Deferred)

**Triggers:** Retry workflows, parallel execution, or run history requirements.

When needed:
- Generate unique `run_id` distinct from `plan_ref`
- Rename JSON files from `track-*.json` to `run-*.json`
- Migrate internal `id` field to `run_id`
- Support multiple runs per plan

**YAGNI:** Don't build until the need is concrete.

---

## The precise relationship (lock this in)

### **PLAN is the unit of intent**

* Identified by: `initiative / phase.decimal / plan-id`
* Example:

  ```
  specs/feature-01/phase-01.2/03-PLAN.md
  ```

### **RUN is the unit of execution**

* Spawned **from a PLAN**
* Tracks *one execution attempt* of that PLAN
* There may be **0, 1, or many runs per PLAN**

So:

> **Runs are per PLAN, not per phase — phase is just PLAN’s address.**

---

## Why this distinction matters (future-proofing)

### 1. Reruns become trivial

If a PLAN needs to be re-executed:

```
PLAN.md
├─ run-001  (failed UAT)
├─ run-002  (partial, aborted)
└─ run-003  (passed → SUMMARY.md)
```

No overwriting. No ambiguity. Full audit trail.

---

### 2. Parallelism stays clean

You may eventually want:

* parallel experiments
* agent vs human execution
* dry-run vs real-run

All of those are **multiple runs of the same PLAN**.

---

### 3. SUMMARY.md semantics stay correct

Your rule already implies this:

> SUMMARY.md is created **when a PLAN is complete**

That means:

* SUMMARY.md corresponds to **the accepted run**
* Not necessarily the *first* run
* Not an average of runs

This only works cleanly if **run ≠ plan**.

---

## Concrete mapping (filesystem + runtime)

### Filesystem (authoritative intent)

```
specs/
  feature-01/
    phase-01.2/
      03-PLAN.md
      03-SUMMARY.md   ← produced by accepted run
```

### Runtime (execution ledger)

```
.tiller/
  runs/
    run-41ezmk.json
    run-41ezml.json
```

Each run file contains:

```json
{
  "run_id": "run-41ezmk",
  "plan_ref": "feature-01/phase-01.2/03",
  "state": "verifying/passed",
  "beads": ["bead-12", "bead-13"]
}
```

> **Runs are per PLAN; PLANs are scoped by `phase.decimal`, so runs inherit that scope but are not owned by the phase.**

If you ever feel tempted to say “run per phase”, that’s a smell — phases don’t execute, **plans do**.


## Core principle (lock this in)

> **`status`, `ready`, and planning views are PLAN-centric.
> `run` only exists after execution starts.
> Before that, everything is a proposal.**

This is the key that keeps the CLI calm instead of “over-runtime’d”.

---

## Mental model (one picture, no ambiguity)

```
PLAN (proposal)
  ├─ drafted
  ├─ approved
  └─ ready
       ↓ start
RUN (execution)
  ├─ active
  ├─ verifying
  └─ finalized
```

No run → no runtime truth → no execution state.

---

## Command-by-command semantics

### `tiller status`

**Scope:** initiative / phase / plan
**Question it answers:** *“Where do things stand?”*

What it shows:

* Plans by initiative/phase
* Their **planning status**:

  * drafted
  * approved
  * ready
* If a plan has a run:

  * show the **current run state**
  * otherwise: `—` or `not started`

Example (conceptual):

```
feature-01 / phase-01.2

03  PLAN  ready        (no run)
04  PLAN  active       run-41ezmk (verifying/testing)
05  PLAN  approved     (no run)
```

Key rule:

* `status` **does not require a run to exist**
* It never errors because “nothing is running”

---

### `tiller ready`

**Scope:** actionable plans
**Question it answers:** *“What can I do next?”*

This is **pre-run by design**.

It lists plans that are:

* approved
* ready
* not currently running
* not blocked by deps

Example:

```
READY
- feature-01/phase-01.2/03
- feature-02/phase-02.1/01
```

This is the *agent entry point*.

> If `ready` ever required a run, something went wrong.

---

### `tiller show <ref>`

This command is **polymorphic**, and that’s OK.

#### Case 1 — PLAN only (no run yet)

```bash
tiller show 03
```

Shows:

* PLAN.md
* objective
* tasks
* success criteria
* status: `ready`
* note: `no runs yet`

This reinforces:

> *This is a proposal.*

---

#### Case 2 — PLAN with an active or completed run

```bash
tiller show 03
```

Shows:

* PLAN summary
* latest run (or selected run)
* run state
* tasks / beads
* verification status
* link to SUMMARY.md if finalized

Run is **attached**, not assumed.

---

#### Case 3 — Explicit run

```bash
tiller show run-41ezmk
```

Shows:

* execution details only
* transitions
* logs
* beads
* UAT results

No planning noise.

---

### `tiller run …`

This is where runtime *begins*.

```bash
tiller run start 03
```

Meaning:

* create run
* associate with plan 03
* transition plan from “ready” → “in execution (via run)”

Before this moment:

* there is nothing to “track”
* there is nothing to “pause”
* there is nothing to “verify”

That’s clean.

---

## Why this is the right boundary

You said:

> if nothing is "run" they are just proposals

That sentence is **100% correct** and should be treated as doctrine.

It gives you:

* no fake runtime state
* no empty run objects
* no confusion in agents
* no premature claims / locks
* clean summaries

Many tools get this wrong. You don’t have to.

---

## One-line command contract (worth writing down)

> **Planning commands operate on PLANs.
> Runtime commands operate on RUNs.
> `show` can speak both languages.**

If you want next, we can:

* formalize `status` output columns
* decide how `latest run` vs `selected run` works
* design how `tiller ready` ranks or filters plans
* add a `tiller runs <plan-ref>` command for history

