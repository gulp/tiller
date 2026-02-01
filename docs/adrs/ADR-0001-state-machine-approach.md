# ADR-0001: State Machine Approach for Tiller Workflows

**Status:** Accepted
**Date:** 2026-01-16
**Decision Makers:** @gulp

## Context

Tiller currently uses stringly-typed state management:

```typescript
matchState(run.state, "verifying")
run.state === "complete"
applyTransition(run, "verifying/testing" as RunState, "agent")
```

This approach has 155 occurrences across 14 files. Concerns:
- No compile-time validation of state strings
- Transitions scattered across command handlers
- Typo-prone, no IDE autocomplete
- Difficult to visualize workflow

Future requirements suggest "ever-growing workflows" and "drop-in workflow detection" - implying dynamic, pluggable workflow definitions.

## Options Considered

### Option A: XState

**Pros:**
- 28,700 GitHub stars, industry standard
- Visual editor via Stately.ai
- Type-safe states and events
- Hierarchical/parallel state support
- Can load definitions from JSON/database ([confirmed](https://github.com/statelyai/xstate/discussions/1517))

**Cons:**
- Medium learning curve
- Large blast radius refactor (14 files)
- Dependency added

**Dynamic workflow support:**
```typescript
// Structure from JSON/YAML
const machineConfig = JSON.parse(workflowDefinition);
// Implementations in code
const machine = createMachine(machineConfig).provide({
  actions: { notifyUser: () => {...} },
  guards: { canComplete: () => {...} }
});
```

### Option B: Custom TypeScript (No Dependencies)

**Pros:**
- Zero deps, zero learning curve
- Every TS dev knows the pattern
- Full type safety

**Cons:**
- Reinventing wheel
- No visualization
- Manual transition validation

```typescript
const STATES = ['proposed', 'approved', 'active/executing', ...] as const;
type TrackState = typeof STATES[number];

const TRANSITIONS: Record<TrackState, readonly TrackState[]> = {
  'proposed': ['approved', 'abandoned'],
  // ...
};
```

### Option C: YAML Workflow Definitions (Dynamic)

**Pros:**
- Zero blast radius (additive layer)
- Workflows as data, not code
- Plugins can ship custom workflows
- Drop-in detection via file discovery

**Cons:**
- Runtime-only validation
- Must build from scratch

```yaml
# .tiller/workflows/hotfix.yaml
name: hotfix
states:
  proposed: { transitions: [active] }  # skip approval
  active: { transitions: [complete] }   # skip verification
```

## Research Findings

Investigation confirmed XState DOES support dynamic definitions:
- `createMachine()` accepts JSON configuration
- Implementation bindings provided separately via `.provide()`
- Pattern: store structure in JSON, keep implementations in code
- Used in production for per-user dynamic workflows ([source](https://www.darraghoriordan.com/2024/01/30/dynamic-state-machines-xstate-lambda))

## Decision

**Accepted: Option B (Custom TypeScript)**

> [!NOTE]
> This ADR originally recorded Option A (XState) as the decision. During
> implementation, Option B was chosen instead — zero dependencies, simpler
> mental model, and the HSM complexity stayed manageable. The codebase uses
> a hand-rolled `VALID_TRANSITIONS` table with slash-notation states
> (`active/executing`, `verifying/passed`) defined in `src/tiller/types/index.ts`.

Rationale (updated to reflect actual implementation):
1. Zero dependencies — no XState, no sub-deps
2. Full type safety via `RunState` union type with template literals
3. HSM expressed naturally with slash notation (`active/executing`, `verifying/passed`)
4. `VALID_TRANSITIONS` table is the single source of truth for all state transitions
5. `canTransition()` handles both exact and parent-level matching

## Consequences

- Zero new dependencies
- State machine is a simple lookup table (~35 lines) in `types/index.ts`
- No visualization tooling (trade-off accepted; mermaid diagrams serve this need)
- Adding states or transitions is a one-line table edit
- Dynamic/pluggable workflows remain a future option via YAML (Option C)

## References

- [XState GitHub](https://github.com/statelyai/xstate) - 28.7k stars
- [Loading from DB discussion](https://github.com/statelyai/xstate/discussions/1517) - David Khourshid's answer
- [Dynamic machines with Lambda](https://www.darraghoriordan.com/2024/01/30/dynamic-state-machines-xstate-lambda) - Production pattern
- [Stately Studio](https://stately.ai/) - Visual editor
