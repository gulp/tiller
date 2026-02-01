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

**Accepted: Option A (XState)**

Rationale:
1. Dynamic workflow support confirmed
2. Large ecosystem reduces long-term maintenance
3. Visualization aids debugging/documentation
4. Type safety with industry-standard patterns

Alternative: **Option C** if minimal investment preferred and XState learning curve deemed too high.

## Consequences

### If XState chosen:
- Medium refactor effort (2-3 sessions)
- New dependency (zero sub-deps)
- Gain: visualization, ecosystem, type safety
- Workflows can be stored as JSON for future plugin support

### If Custom/YAML chosen:
- Lower initial effort
- No new dependencies
- Must build workflow loader/validator from scratch
- Less ecosystem support long-term

## References

- [XState GitHub](https://github.com/statelyai/xstate) - 28.7k stars
- [Loading from DB discussion](https://github.com/statelyai/xstate/discussions/1517) - David Khourshid's answer
- [Dynamic machines with Lambda](https://www.darraghoriordan.com/2024/01/30/dynamic-state-machines-xstate-lambda) - Production pattern
- [Stately Studio](https://stately.ai/) - Visual editor
