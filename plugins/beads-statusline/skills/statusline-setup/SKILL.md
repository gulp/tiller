---
name: statusline-setup
description: Configure beads-statusline in Claude Code settings. Use when user wants to enable the beads task statusline display.
---

# Beads Statusline Setup

Configure Claude Code to show your current beads task in the statusline.

## Configuration

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/plugins/cache/ace-skills/beads-statusline/0.1.0/scripts/beads-statusline.sh"
  }
}
```

Or if installed locally:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/ace-skills/plugins/beads-statusline/scripts/beads-statusline.sh"
  }
}
```

## Verification

1. Claim a task: `bd update <id> --status=in_progress`
2. The statusline should show: `⚙ <id>: <title>...`
3. Close task: `bd close <id>`
4. After cache expires (~5s), statusline clears

## Troubleshooting

- **No output**: Check if `.beads/` directory exists in your project
- **Slow**: Check `bd` command performance, increase timeout in script if needed
- **Stale data**: Delete cache file: `rm /tmp/beads-statusline-*`
