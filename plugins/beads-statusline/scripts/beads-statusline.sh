#!/usr/bin/env bash
# beads-statusline.sh - Show current in_progress beads task in Claude Code statusline
#
# Outputs: "<cyan gear> <issue-id>: <truncated-title>" or empty if no task
# Performance: Uses caching with 5-second TTL, 500ms timeout on bd command
#
# For multi-agent support:
# - If BD_STATUSLINE_TASK env var is set, shows that specific task
# - Otherwise shows all in_progress tasks (up to 3)

# Read and discard stdin (Claude passes workspace info)
cat > /dev/null

# Fast exit if not in a beads project
if [[ ! -d ".beads" ]]; then
  exit 0
fi

# If BD_STATUSLINE_TASK is set, show that specific task
if [[ -n "$BD_STATUSLINE_TASK" ]]; then
  json=$(timeout 0.5 bd show "$BD_STATUSLINE_TASK" --json 2>/dev/null)
  if [[ -n "$json" ]]; then
    if command -v jq &>/dev/null; then
      # bd show --json returns an array, get first element
      id=$(echo "$json" | jq -r '.[0].id // empty' 2>/dev/null)
      title=$(echo "$json" | jq -r '.[0].title // empty' 2>/dev/null)
    else
      id=$(echo "$json" | grep -oP '"id"\s*:\s*"\K[^"]+' | head -1)
      title=$(echo "$json" | grep -oP '"title"\s*:\s*"\K[^"]+' | head -1)
    fi
    if [[ -n "$id" ]]; then
      [[ ${#title} -gt 25 ]] && title="${title:0:22}..."
      printf '\033[36m⚙\033[0m %s: %s' "$id" "$title"
    fi
  fi
  exit 0
fi

# Get cache key based on git root or pwd
if git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  cache_key=$(echo "$git_root" | md5sum | cut -c1-8)
else
  cache_key=$(pwd | md5sum | cut -c1-8)
fi

cache_file="/tmp/beads-statusline-${USER}-${cache_key}.cache"
cache_ttl=5

# Check cache
if [[ -f "$cache_file" ]]; then
  cache_age=$(($(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0)))
  if [[ $cache_age -lt $cache_ttl ]]; then
    cat "$cache_file"
    exit 0
  fi
fi

# Fetch in_progress tasks with timeout (up to 3)
json=$(timeout 0.5 bd list --status=in_progress --limit=3 --json 2>/dev/null)

if [[ -z "$json" || "$json" == "[]" ]]; then
  # No in_progress tasks - clear cache and output nothing
  rm -f "$cache_file" 2>/dev/null
  exit 0
fi

# Parse JSON and format output
output=""
if command -v jq &>/dev/null; then
  count=$(echo "$json" | jq 'length' 2>/dev/null)
  for ((i=0; i<count && i<3; i++)); do
    id=$(echo "$json" | jq -r ".[$i].id // empty" 2>/dev/null)
    title=$(echo "$json" | jq -r ".[$i].title // empty" 2>/dev/null)
    if [[ -n "$id" ]]; then
      # Shorter truncation for multiple tasks
      if [[ $count -gt 1 ]]; then
        [[ ${#title} -gt 15 ]] && title="${title:0:12}..."
      else
        [[ ${#title} -gt 30 ]] && title="${title:0:27}..."
      fi
      [[ -n "$output" ]] && output+=" | "
      output+="\033[36m⚙\033[0m $id: $title"
    fi
  done
else
  # Fallback: just show first task
  id=$(echo "$json" | grep -oP '"id"\s*:\s*"\K[^"]+' | head -1)
  title=$(echo "$json" | grep -oP '"title"\s*:\s*"\K[^"]+' | head -1)
  if [[ -n "$id" ]]; then
    [[ ${#title} -gt 30 ]] && title="${title:0:27}..."
    output="\033[36m⚙\033[0m $id: $title"
  fi
fi

if [[ -z "$output" ]]; then
  rm -f "$cache_file" 2>/dev/null
  exit 0
fi

# Cache and output
echo -e "$output" > "$cache_file"
echo -e "$output"
