# SUMMARY.md Schema

Enhanced SUMMARY.md format for MQ-queryable, human-readable, and verifiable documentation.

## File Naming States

SUMMARY files progress through three naming states:

| File | State | Meaning |
|------|-------|---------|
| `SUMMARY.md` | Draft | Generated but not yet verified |
| `SUMMARY.autopass.md` | Auto-passed | Verification auto-passed (no UAT checks defined) |
| `SUMMARY.done.md` | Finalized | Verification passed and run completed |

The `tiller complete` command renames `SUMMARY.md` → `SUMMARY.done.md` (or `SUMMARY.autopass.md` if auto-passed).

## Purpose

SUMMARY.md files serve as:
1. **Archive**: Permanent record of what was built
2. **Verification**: Machine-checkable claims about deliverables
3. **Context**: LLM-readable source for future work
4. **Audit Trail**: Git commit history for traceability

## Schema

```markdown
---
epic_id: <beads-epic-id>
phase: <phase-number>
plan: <plan-number>
baseline_commit: <git-hash>
---

# Phase X Plan Y: <Title>

## Objective
[From PLAN.md objective section - single paragraph]

## Deliverables
- `<filepath>` - <purpose>
- `<filepath>` - <purpose>

## Tasks
1. <task-title> - <outcome>
2. <task-title> - <outcome>

## Verification
- ✓ `<command>` - passed
- ✗ `<command>` - failed: <reason>

## Commits
- `<short-hash>` <commit-message>
- `<short-hash>` <commit-message>

## Notes
- <aggregated observations from task close_reasons>
- <design decisions or caveats>
```

## Section Details

### Frontmatter (YAML)

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| `title` | **Yes** | Plan title (from PLAN.md frontmatter) | `Agent Observability` |
| `epic_id` | No | Beads epic ID for this plan | `tiller-xyz` |
| `phase` | No | Phase number | `02.1` |
| `plan` | No | Plan number within phase | `05` |
| `completed` | No | Completion timestamp | `2026-01-20T12:00:00Z` |
| `tasks_completed` | No | Count of completed tasks | `6` |

> **Note:** `baseline_commit` is documented here for future use but is not
> currently generated. Commits are extracted via `git log --since=<run_created_at>`.

### Objective

Single paragraph from PLAN.md `<objective>` section. Should answer:
- What was the goal?
- Why was it needed?

### Deliverables

List of files created/modified with their purpose:
- Use backticks around filepaths for MQ extraction
- Keep descriptions concise (< 50 chars)
- Source: PLAN.md `files_modified` frontmatter

### Tasks

Numbered list of completed tasks with outcomes:
- Format: `<number>. <title> - <outcome>`
- Source: `beads_snapshot` field from run (if available), otherwise PLAN.md tasks
- Outcomes should describe what was achieved, not just "done"

### Verification

Results of automated and manual checks:
- `✓` for passed checks
- `✗` for failed checks with reason
- Use backticks around commands
- Source: `run.verification.automated` and `run.verification.uat`

### Commits

Git commits made during plan execution:
- Short hash (7 chars) in backticks
- Commit message (first line only)
- Source: `git log --oneline --since=<run_created_at>` filtered by `files_modified` paths

### Notes

Aggregated observations and decisions:
- Important caveats or limitations
- Design decisions made during execution
- Source: Task close_reasons and manual additions

## MQ Query Examples

[MQ (Markdown Query)](https://mqlang.org/) enables programmatic extraction.

### Extract Objective
```bash
mq '.h2:contains("Objective") + p | to_text()' SUMMARY.md
```

### List Deliverables (filepaths only)
```bash
mq '.h2:contains("Deliverables") + ul li code | to_text()' SUMMARY.md
```

### Get Task Outcomes
```bash
mq '.h2:contains("Tasks") + ol li | to_text()' SUMMARY.md
```

### Check Verification Status
```bash
mq '.h2:contains("Verification") + ul li | to_text()' SUMMARY.md
```

### Extract Commit Hashes
```bash
mq '.h2:contains("Commits") + ul li code | to_text()' SUMMARY.md
```

### Get Notes
```bash
mq '.h2:contains("Notes") + ul li | to_text()' SUMMARY.md
```

## Drift Detection

SUMMARY claims can be verified against reality:

```bash
# Check all deliverables exist
mq '.h2:contains("Deliverables") + ul li code | to_text()' SUMMARY.md | \
  while read -r file; do
    [ -f "$file" ] && echo "✓ $file" || echo "✗ $file (MISSING)"
  done

# Verify commits exist in git history
mq '.h2:contains("Commits") + ul li code | to_text()' SUMMARY.md | \
  while read -r hash; do
    git rev-parse "$hash" >/dev/null 2>&1 && echo "✓ $hash" || echo "✗ $hash (NOT FOUND)"
  done
```

## Example SUMMARY.md

```markdown
---
epic_id: tiller-hf1
phase: 02
plan: 05
baseline_commit: abc1234
---

# Phase 02 Plan 05: Agent Observability

## Objective
Enable humans to observe multiple Claude agents working on different tracks from a central orchestrator window.

## Deliverables
- `src/tiller/types/index.ts` - AgentStatus type definitions
- `src/tiller/state/agent.ts` - Agent state management
- `src/tiller/commands/agent.ts` - Agent CLI commands

## Tasks
1. Add agent types - Added AgentStatus and AgentState types
2. Implement agent state module - CRUD operations for agent status files
3. Implement agent commands - register, report, heartbeat, unregister
4. Register commands in CLI - All commands available via tiller agent
5. Update status to show agents - AGENTS section in tiller status
6. Link agent to run on claim - Auto-updates agent.run_id

## Verification
- ✓ `tiller agent --help` - Shows all subcommands
- ✓ `tiller agents` - Lists registered agents
- ✓ `tiller status` - Shows AGENTS section

## Commits
- `def5678` feat(agent): add agent observability commands
- `ghi9012` feat(status): show agents in tiller status

## Notes
- Agents self-identify via $TILLER_AGENT environment variable
- Stale detection (>5min no heartbeat) shows warning marker
- Run claiming auto-updates agent state to 'working'
```

## Generation Sources

| Section | Actual Source |
|---------|--------|
| Frontmatter | PLAN.md frontmatter (`title` required) |
| Objective | PLAN.md `objective` frontmatter or first `## Objective` section |
| Deliverables | PLAN.md `files_modified` frontmatter |
| Tasks | `beads_snapshot` from run, falling back to PLAN.md tasks |
| Verification | `run.verification` events (event-sourced) |
| Commits | `git log --oneline --since=<created_at>` filtered by `files_modified` |
| Notes | Currently empty (manual additions only) |
