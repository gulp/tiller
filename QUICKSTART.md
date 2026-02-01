# Quick Start Guide

## Installation

### Prerequisites

| Dependency | Version | Check |
|------------|---------|-------|
| Node.js | >= 18.0.0 | `node --version` |
| bun | >= 1.0.0 | `bun --version` |
| git | >= 2.0.0 | `git --version` |

### Install from source

```bash
git clone https://github.com/gulp/tiller.git
cd tiller
bun install
bun run build
bun link          # makes 'tiller' and 'ahoy' available globally
```

### Verify installation

```bash
tiller --version
tiller doctor
```

## Initialize a project

```bash
cd your-project
tiller setup      # creates .tiller/ and plans/ structure
```

This creates the scaffolding tiller needs to track work.

## Your first plan

```bash
tiller plan create "Add user authentication"
# Creates plans/{initiative}/{phase}/01-01-PLAN.md

tiller activate 01-01       # Start work
# ... implement the feature ...
tiller verify 01-01 --pass  # Mark verified
tiller complete 01-01       # Finalize with SUMMARY.md
```

## Sample Claude Code conversation

```
You: "I want to add a new feature to my app. Can you help me plan it?"

Claude: "Let me create a plan for the feature..."
       [Claude uses tiller plan create to make a plan]

You: "tiller activate 01-01"

Claude: "Starting work on the feature... [implements code]"
       "Work complete. Ready for verification."

You: "tiller verify 01-01 --pass"
You: "tiller complete 01-01"

Claude: "Generated SUMMARY.md. Feature complete!"
```

## Common commands

```bash
tiller status              # Current state + next action
tiller plan create "obj"   # Create new plan
tiller activate <ref>      # Start work on a plan
tiller pause <ref>         # Pause with handoff context
tiller resume <ref>        # Resume paused work
tiller verify <ref> --pass # Mark verification passed
tiller complete <ref>      # Finalize with SUMMARY.md
tiller doctor              # Health check
```

## Planning with ahoy

Explore ideas before committing to implementation:

```bash
ahoy draft feature-name     # Create unnumbered draft
ahoy discuss feature-name   # Interactive requirements
ahoy number feature-name    # Assign ID when ready
```

## Learn more

- [README.md](README.md) - Full documentation
- [docs/TILLER-DESIGN.md](docs/TILLER-DESIGN.md) - Architecture and state machine
- [docs/TILLER-INSTALL.md](docs/TILLER-INSTALL.md) - Detailed installation guide
