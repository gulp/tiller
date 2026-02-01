# Project: {{PROJECT_NAME}}

## Build Commands
- `npm run build` - compile TypeScript
- `npm test` - run tests

## Notes
- Add project-specific notes here

## Agent Context

This file provides context for Claude Code when working on your project.
Add information that helps Claude understand your project's conventions, architecture, and workflows.

## Workflow Settings (DEPRECATED - Will move to tiller.toml)

<!--
  NOTE: These settings will be moved to tiller.toml in future version (plan 11-07)
  For now, they must be defined here as YAML frontmatter.

  confirm-mode: false (default) - commands execute immediately
  confirm-mode: true - commands return TOON for human confirmation
  Override per-command: --confirm or --no-confirm

  require-summary: false - complete without SUMMARY.md
  require-summary: true - require SUMMARY.md for completion
  Not set: returns TOON for agent to decide/ask user
-->
confirm-mode: false
require-summary: true
