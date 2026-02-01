# Agent Instructions

## Development

- Use `bun run test <pattern>` for targeted testing
- Use `tsc --noEmit` for type checking
- Follow agent-first design principles in CLAUDE.md

## Session Completion

When ending a work session:

1. Run quality gates: `tsc --noEmit`, relevant tests
2. Commit and push changes
3. Provide context for next session
