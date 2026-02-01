# Quick Start Guide

## Sample Claude Conversation

```
You: "I want to add a new feature to my app. Can you help me plan it?"

Claude: "I'd be happy to help! Let me create a plan for the feature..."

[Claude uses tiller plan create to make a plan]

You: "tiller activate 01-01"

Claude: "Starting work on the feature... [implements code]"
Claude: "Work complete. Ready for verification."

You: "tiller verify 01-01 --pass"

Claude: "Verification passed. Ready to finalize."

You: "tiller complete 01-01"

Claude: "Generated SUMMARY.md. Feature complete!"
```

## Workflow Overview

### Planning (ahoy)
Explore ideas and create specs before committing to implementation:

```bash
ahoy draft feature-name     # Create unnumbered draft
ahoy discuss feature-name   # Interactive requirements
ahoy number feature-name    # Assign ID when ready
```

### Execution (tiller)
Execute approved work with state tracking:

```bash
tiller accept 0001-feature  # Create execution plans
tiller activate 01-01       # Start work
tiller verify 01-01 --pass  # Verify completion
tiller complete 01-01       # Finalize
```

## Common Commands

```bash
tiller status              # See current state
tiller plan create "obj"   # Create new plan
tiller activate <ref>      # Start work
tiller verify <ref> --pass # Mark verified
tiller complete <ref>      # Generate SUMMARY
```

## Learn More

See [README.md](README.md) for complete documentation.
