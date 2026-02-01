# Ahoy Workflow Context

> **Context Recovery**: Run `ahoy prime` after compaction, clear, or new session
> Hooks auto-call this in Claude Code when specs/ detected

## What is Ahoy?

Ahoy is the intent-shaping CLI for multi-initiative planning. It manages:
- **Specs/Drafts**: Design documents through lifecycle (drafting → numbered → locked)
- **Initiatives**: Project plans in plans/ directory
- **Phase Planning**: TOON-serialized context for planning phases

## Draft Lifecycle

| State | Description | Next Action |
|-------|-------------|-------------|
| `drafting` | Work in progress | `ahoy number <draft>` |
| `numbered` | Identity assigned | `ahoy lock <draft>` |
| `locked` | Committed, immutable | Done |

## Essential Commands

```bash
ahoy status            # Show draft lifecycle state
ahoy list              # List initiatives
ahoy draft <name>      # Create new draft
ahoy show <draft>      # Show draft details
ahoy number <draft>    # Assign sequential ID
ahoy lock <draft>      # Commit draft (immutable)
```

## Agent-First Commands

```bash
ahoy discuss <topic>   # Start structured discussion
ahoy research <query>  # Research a topic
ahoy review <draft>    # Review a draft
ahoy scope <feature>   # Scope a feature
```

## Phase Planning

```bash
ahoy phase prime <initiative> <phase>  # Output TOON context for phase
```
