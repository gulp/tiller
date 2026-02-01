# Constitutional Rules

This directory contains constitutional rules that are automatically injected by tiller commands like `tiller activate`.

## How It Works

When you run `tiller activate`, tiller reads all `.md` files in this directory (alphabetically) and displays them as reminders before starting work.

## Customizing Rules

1. Review the example files (`.example` suffix)
2. Copy or rename examples to remove `.example` suffix
3. Edit the content to match your project's needs
4. Create new `.md` files for custom rules

**Example:**
```bash
cp 01-test-integrity.md.example 01-test-integrity.md
# Edit 01-test-integrity.md with your rules
```

## File Naming

Files are loaded alphabetically:
- `01-test-integrity.md` - Test quality rules
- `02-verification.md` - Verification mindset
- `99-custom.md` - Your custom rules

Use numeric prefixes to control order.

## Disabling Rules

Rename files to add `.disabled` or `.example` suffix:
```bash
mv 01-test-integrity.md 01-test-integrity.md.disabled
```

Tiller only loads `.md` files (not `.example`, `.disabled`, etc.).
