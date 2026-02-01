# ADR-0007: Prose-First Verification with --ci Escape Hatch

**Status:** Accepted
**Date:** 2026-01-18
**Decision Makers:** @gulp
**Related:** plans/tiller-cli/06.6-tiller-ax-friction/06.6-33-PLAN.md

## Context

PLAN.md files need a `<verification>` section to define completion criteria. The 08-03 design hard-required YAML format, but ~90% of existing plans use prose.

**Problem:** YAML-first is compiler-first, not agent-first. Agents understand natural language. Forcing YAML adds authoring overhead for manual UAT checks.

**Design principle (from CLAUDE.md):**
> Every architectural decision must be agent-first.

## Decision

**Prose-first verification as default. YAML format becomes opt-in escape hatch via `--ci` flag.**

| Command | Behavior |
|---------|----------|
| `tiller verify` | Default: parses prose as checklist, outputs for agent interpretation |
| `tiller verify --ci` | Strict: requires YAML, machine-deterministic, fails on ambiguity |

### Prose format (default)

```markdown
<verification>
- `tiller phase insert 06 "test"` creates phase 07
- Existing phase 07 renamed to 08
- ROADMAP.md updated correctly
</verification>
```

Agent interprets and verifies these checks. Each bullet becomes a manual check item.

### YAML format (--ci mode)

```yaml
<verification>
- name: type_check
  cmd: tsc --noEmit
- name: creates_phase
  cmd: "tiller phase insert 06 'test' --dry-run | grep -q 'phase 07'"
</verification>
```

Machine-deterministic execution. Exit codes: 0 = all pass, 1 = any fail.

## Rationale

1. **Agent-first means trusting the agent** - Capable agents understand prose and determine appropriate verification
2. **Plans are human artifacts** - Readable and writable without schema knowledge
3. **Verification intent > verification commands** - "Ensure type safety" is more durable than "run `tsc --noEmit`"
4. **CI needs determinism** - `--ci` flag provides escape hatch for pipelines requiring machine-verifiable checks

## Consequences

- `tiller verify` (default) works with prose - outputs checklist as TOON for agent
- `tiller verify --ci` requires YAML - errors gracefully when prose detected
- Both YAML and prose plans continue to work
- SUMMARY.md captures what was actually verified

## Implementation

See plan 06.6-33 for implementation tasks:
- Add `parseProseVerification()` to detect format and parse accordingly
- Update `tiller verify` to be prose-tolerant by default
- Add `--ci` flag for strict YAML mode
- Remove hard error for prose sections
