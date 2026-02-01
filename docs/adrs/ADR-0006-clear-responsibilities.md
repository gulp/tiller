Let’s lock a **clean separation of responsibility**

## Short answer (then I’ll justify it)

- **`check` never fixes**
- **`doctor` interprets checks**
- **`fix` proposes changes**
- **`repair` mutates**
- **`status` only reports**

No exceptions.

---

## 1. `check`: detection only (read-only, repeatable)

> **`check` answers: “Is something wrong?”**

Characteristics:

- read-only
- deterministic
- safe to run constantly
- no side effects
- no decisions

Example:

```bash
tiller check
```

Output (human):

```
ERROR   run-41ezmk finalized but missing SUMMARY.md
WARN    phase-02 missing expected subphase 02.1
INFO    plan 03 approved but never started
```

Output (JSON for agents):

```json
{
  "findings": [
    {
      "level": "error",
      "code": "RUN_MISSING_SUMMARY",
      "ref": "run-41ezmk",
      "message": "Finalized run has no SUMMARY.md"
    }
  ]
}
```

**Important:**
`check` does **not** know _how_ to fix anything.

It only asserts invariants.

---

## 2. Conflicts are just findings (don’t special-case them)

A “conflict” is **not a command**.
It’s just a finding with a higher severity.

Examples:

- phase numbering collision
- two plans claim same slot
- summary exists but mismatched run
- verification passed but acceptance missing

These are:

```
ERROR  PHASE_CONFLICT
ERROR  SUMMARY_MISMATCH
```

Not actions.

---

## 3. `doctor`: interpretation + advice (still no mutation)

> **`doctor` answers: “What should we do about these findings?”**

This is the _human-facing_ layer.

```bash
tiller doctor
```

What it does:

- runs `check`
- groups findings
- explains causes
- suggests remedies
- may rank urgency

Example output:

```
Diagnosis:
- 1 critical integrity issue detected

Cause:
- run-41ezmk was finalized without generating SUMMARY.md

Recommended actions:
- Run: tiller fix summary --from-run run-41ezmk
- Or: create SUMMARY.md manually and re-run tiller check
```

Key rule:

> **`doctor` never changes state. It only advises.**

Think: `brew doctor`, not `brew install`.

---

## 4. `fix`: proposal / staging (optional but powerful)

> **`fix` answers: “Here’s what I would change.”**

This is where you _prepare_ changes without applying them.

```bash
tiller fix summary --from-run run-41ezmk
```

What it does:

- generates files (e.g. SUMMARY.md)
- stages renumbering plans
- outputs diffs
- writes FIX-PLAN.md or temp artifacts

But:

- does **not** mutate canonical state
- does **not** advance lifecycle

This is especially useful for agents.

---

## 5. `repair`: the only mutating command

> **`repair` answers: “Apply the fix.”**

This is the **only** place where the system changes shape.

```bash
tiller repair summary --from-run run-41ezmk
tiller repair phases --reindex
```

Rules:

- loud
- explicit
- logged
- auditable
- reversible if possible

This is your `git commit`.

---

## 6. Should there be `fix --all`?

### Yes — but **never without a scope**

Good:

```bash
tiller fix summaries
tiller fix phases
```

Bad:

```bash
tiller fix --all    ❌
```

Why:

- different findings require different intent
- “all” hides consequences
- LLMs will overuse it

If you _do_ want a convenience:

```bash
tiller fix --category summaries
tiller fix --severity error
```

Still explicit.

---

## 7. What does `status` do in all this?

> **`status` only reports — it never diagnoses or fixes.**

`tiller status`:

- shows planning state (PLAN)
- shows execution state (RUN)
- may show a **badge** if checks are failing

Example:

```
03  PLAN  ready
04  PLAN  active (run-41ezmk)  ⚠ integrity issues
```

But it does **not** list the issues.

For details:

```bash
tiller check
```

This keeps `status` fast and calm.

---

## 8. The full responsibility table (pin this)

| Command  | Reads | Writes            | Decides |
| -------- | ----- | ----------------- | ------- |
| `status` | ✅    | ❌                | ❌      |
| `check`  | ✅    | ❌                | ❌      |
| `doctor` | ✅    | ❌                | ❌      |
| `fix`    | ✅    | ⚠️ (temp)         | ❌      |
| `repair` | ✅    | ✅                | ✅      |
| `verify` | ✅    | ✅ (verification) | ⚠️      |
| `accept` | ✅    | ✅                | ✅      |

---

## 9. The doctrine (this ends future confusion)

> **Checks detect.
> Doctors explain.
> Fixes propose.
> Repairs commit.
> Status reports.**

If a command violates that sentence, it’s doing too much.
