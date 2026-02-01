# Tiller Installation & Prerequisites

**Version:** 0.2.0-draft
**Date:** 2026-01-15

## Overview

Tiller is the execution custody layer. Unlike ahoy (which is standalone), tiller has hard dependencies that must be satisfied for reliable operation.

Tiller manages execution state for ALL initiatives in a repository via a single `.tiller/` directory. Run IDs include initiative prefixes (e.g., `tiller--04-01`, `ace--01-01`).

## Prerequisites

### Required

| Dependency | Version | Purpose | Check Command |
|------------|---------|---------|---------------|
| Node.js | ≥18.0.0 | Runtime | `node --version` |
| beads (bd) | ≥0.5.0 | Issue tracking | `bd --version` |
| git | ≥2.0.0 | Version control | `git --version` |

### Optional

| Dependency | Purpose | Check Command |
|------------|---------|---------------|
| bun | Faster execution | `bun --version` |
| BATS | Smoke tests | `bats --version` |

---

## Installation

### 1. Install tiller

```bash
# From source (recommended - requires bun)
git clone https://github.com/gulp/tiller
cd tiller
bun install
bun run build
bun link  # makes 'tiller' and 'ahoy' available globally
```

### 2. Verify prerequisites

```bash
tiller doctor --check-prereqs
```

**Expected output:**
```
Tiller Prerequisites Check
══════════════════════════

✓ Node.js 22.0.0 (required: ≥18.0.0)
✓ beads (bd) 0.5.2 (required: ≥0.5.0)
✓ git 2.43.0 (required: ≥2.0.0)

Optional:
✓ bun 1.1.0 (faster execution)
○ BATS not found (smoke tests disabled)

Initiatives:
  specs/tiller/  [detected]
  specs/ace/     [detected]

All required prerequisites satisfied.
```

### 3. Initialize beads (if not already)

```bash
# Check if beads initialized
bd doctor

# If not initialized
bd init
```

---

## Pre-flight Checks

### On Every State-Mutating Command

Before any command that modifies `.tiller/` or `specs/`, tiller runs pre-flight checks:

```typescript
async function preflight(planPath?: string): Promise<PreflightResult> {
  const checks = {
    beadsInstalled: await checkCommand('bd --version'),
    beadsInitialized: await checkPath('.beads/'),
    tillerInitialized: await checkPath('.tiller/'),
    specsExists: await checkPath('specs/'),
    gitRepo: await checkCommand('git rev-parse --git-dir'),
  };

  // If plan path provided, derive and validate initiative
  if (planPath) {
    const initiative = deriveInitiative(planPath);
    checks.initiativeExists = await checkPath(`specs/${initiative}/`);
    checks.initiativeValid = validateInitiativeName(initiative);
  }

  return checks;
}

function deriveInitiative(planPath: string): string {
  // specs/tiller/phases/04-testing/04-01-PLAN.md → "tiller"
  const match = planPath.match(/^specs\/([^/]+)\/phases\//);
  if (!match) throw new Error(`Invalid plan path: ${planPath}`);
  return match[1];
}
```

### Command-Specific Requirements

| Command | Requires beads | Requires .tiller/ | Requires specs/ |
|---------|----------------|-------------------|-----------------|
| `tiller init` | ✓ | creates | ✓ (PLAN.md) |
| `tiller activate` | ✓ | ✓ | - |
| `tiller complete` | ✓ | ✓ | writes SUMMARY |
| `tiller status` | - | ✓ | reads |
| `tiller doctor` | checks | checks | checks |

---

## Version Locking

### Version Manifest

Tiller maintains a version manifest in `.tiller/manifest.json`:

```json
{
  "tiller_version": "0.2.0",
  "contract_version": "0.2.0",
  "beads_version": "0.5.2",
  "created_at": "2026-01-15T16:00:00Z",
  "node_version": "22.0.0",
  "initiatives": ["tiller", "ace"]
}
```

### Compatibility Matrix

| tiller | beads | contract | Status |
|--------|-------|----------|--------|
| 0.1.x | 0.5.x | 0.1.0 | Legacy (single initiative) |
| 0.2.x | 0.5.x | 0.2.0 | Current (multi-initiative) |
| 0.3.x | 0.6.x | 0.3.0 | Future |

### Version Check on Startup

```typescript
function checkVersionCompatibility(): VersionCheck {
  const manifest = readManifest();
  const currentBeads = getBeadsVersion();

  if (semver.major(currentBeads) !== semver.major(manifest.beads_version)) {
    return {
      compatible: false,
      error: `beads major version mismatch: expected ${manifest.beads_version}, got ${currentBeads}`,
      action: 'Run: npm update @beads/cli'
    };
  }

  return { compatible: true };
}
```

---

## Error Handling

### Missing beads

```
tiller init specs/phases/04-testing/04-01-PLAN.md

Error: beads (bd) not found

Tiller requires beads for issue tracking integration.

Install beads:
  npm install -g @beads/cli

Then initialize:
  bd init

Documentation: https://beads.dev/install
```

### beads not initialized

```
tiller init specs/phases/04-testing/04-01-PLAN.md

Error: beads not initialized in this project

Run:
  bd init

This creates .beads/ directory for issue tracking.
```

### Version mismatch

```
tiller activate 04-01

Warning: beads version mismatch
  Expected: 0.5.x
  Found: 0.4.2

Some features may not work correctly.

Upgrade beads:
  npm update -g @beads/cli

Or continue with --force (not recommended)
```

### Missing initiative

```
tiller init specs/tiller/phases/04-testing/04-01-PLAN.md

Error: initiative 'tiller' not found in specs/

Tiller expects ahoy to create initiatives under specs/.

Options:
  1. Run: ahoy init tiller
  2. Create manually: mkdir -p specs/tiller/phases/

Documentation: https://ahoy.dev/getting-started
```

### Invalid plan path

```
tiller init .planning/phases/04-testing/04-01-PLAN.md

Error: invalid plan path

Tiller expects plans at: specs/{initiative}/phases/{phase}/{plan}-PLAN.md
Got: .planning/phases/04-testing/04-01-PLAN.md

Hint: Migrate to namespaced structure with ahoy, or use symlink hack:
  ln -s specs/tiller .planning
```

---

## Graceful Degradation

### Without beads

If beads is not available, tiller can operate in "standalone mode" with reduced functionality:

```bash
tiller init --no-beads specs/phases/04-testing/04-01-PLAN.md
```

**Standalone mode limitations:**
- No epic/issue creation
- No `bd ready` integration
- No dependency tracking via beads
- Track state still managed in `.tiller/`

**Warning shown:**
```
Running in standalone mode (--no-beads)
Issue tracking disabled. Track state managed locally only.
```

### Recovery from standalone

```bash
# Later, when beads is available
bd init
tiller sync --import-runs  # Import existing runs to beads
```

---

## Doctor Command

### `tiller doctor`

Comprehensive health check:

```bash
tiller doctor
```

**Output:**
```
Tiller Health Check
═══════════════════

Prerequisites:
  ✓ Node.js 22.0.0
  ✓ beads (bd) 0.5.2
  ✓ git 2.43.0

Directories:
  ✓ .tiller/ exists
  ✓ .beads/ exists
  ✓ specs/ exists

Initiatives:
  ✓ specs/tiller/ (15 runs, 12 complete)
  ✓ specs/ace/ (3 runs, 0 complete)

Version Compatibility:
  ✓ tiller 0.2.0
  ✓ beads 0.5.2 (compatible)
  ✓ contract 0.2.0

State Integrity:
  ✓ 18 runs in .tiller/runs/
  ✓ 18 matching beads issues
  ✓ No orphaned runs
  ✓ No orphaned issues

Per-Initiative Alignment:
  tiller:
    ✓ STATE.md consistent with runs
    ✓ ROADMAP.md Progress up to date
    ○ 2 runs missing SUMMARY.md (in progress)
  ace:
    ✓ STATE.md consistent with runs
    ✓ ROADMAP.md Progress up to date

Overall: Healthy
```

### `tiller doctor --fix`

Auto-fix common issues:

```bash
tiller doctor --fix
```

**Fixable issues:**
- Sync beads issues with runs
- Update STATE.md from run state
- Update ROADMAP.md Progress table
- Remove orphaned run files

**Non-fixable issues (require manual intervention):**
- Missing prerequisites
- Version mismatches
- Corrupted run state

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Tiller CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: |
          npm install -g @beads/cli @ace/tiller
          npm install

      - name: Initialize beads
        run: bd init --ci

      - name: Check tiller prerequisites
        run: tiller doctor --check-prereqs --ci

      - name: Run tests
        run: npm test
```

### CI Mode

```bash
tiller doctor --ci
```

**CI mode behavior:**
- Exit code 0 = healthy
- Exit code 1 = issues found
- JSON output for parsing
- No interactive prompts

---

## Upgrade Path

### Minor Version Upgrade

```bash
npm update -g @ace/tiller
tiller doctor  # Verify compatibility
```

### Major Version Upgrade

```bash
# 1. Check release notes for breaking changes
# 2. Backup .tiller/
cp -r .tiller .tiller.backup

# 3. Upgrade
npm install -g @ace/tiller@next

# 4. Run migration (if needed)
tiller migrate

# 5. Verify
tiller doctor
```

---

## Summary

### Installation Checklist

```
[ ] Node.js ≥18.0.0 installed
[ ] beads (bd) ≥0.5.0 installed
[ ] git ≥2.0.0 installed
[ ] bd init run in project
[ ] ahoy init <initiative> run (creates specs/<initiative>/)
[ ] tiller doctor passes
```

### Quick Start

```bash
# Prerequisites
npm install -g @beads/cli @ace/tiller @ace/ahoy

# New project with first initiative
ahoy init my-project
bd init
tiller doctor

# Add another initiative
ahoy init another-feature

# Existing project (with specs/)
bd init  # if not already
tiller doctor

# Check all initiatives
ahoy list
tiller status
```

---

*Draft: 2026-01-15*
*Author: Claude*
