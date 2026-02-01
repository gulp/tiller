#!/usr/bin/env bats
# Tiller CLI smoke tests - fast shell-level sanity checks
# Requires bats-core: brew install bats-core OR apt install bats

setup() {
  # Use tsx to run the CLI in development mode
  export TILLER="npx tsx src/tiller/index.ts"
  # Create a temp directory for tests that need filesystem
  export TEST_DIR=$(mktemp -d)
}

teardown() {
  # Clean up temp directory
  rm -rf "$TEST_DIR"
}

@test "tiller --version shows version" {
  run $TILLER --version
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]
}

@test "tiller --help shows usage" {
  run $TILLER --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Intent state tracking" ]]
}

@test "tiller --help lists available commands" {
  run $TILLER --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "approve" ]]
  [[ "$output" =~ "activate" ]]
  [[ "$output" =~ "complete" ]]
}

@test "tiller status without .tiller/ shows error" {
  cd "$TEST_DIR"
  run $TILLER status
  [ "$status" -ne 0 ]
}

@test "tiller init --help shows init command help" {
  run $TILLER init --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "init" ]]
}

@test "tiller list --help shows list command help" {
  run $TILLER list --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "list" ]]
}

@test "tiller nonexistent command exits non-zero" {
  run $TILLER nonexistent
  [ "$status" -ne 0 ]
}

@test "tiller doctor --help shows doctor command help" {
  run $TILLER doctor --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "doctor" ]]
}

@test "tiller verify --help shows verify command help" {
  run $TILLER verify --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "verify" ]]
  [[ "$output" =~ "--pass" ]]
  [[ "$output" =~ "--fail" ]]
}

@test "tiller fix --help shows fix command help" {
  run $TILLER fix --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "fix" ]]
  [[ "$output" =~ "--done" ]]
}

@test "tiller uat --help shows uat command help" {
  run $TILLER uat --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "uat" ]]
}

@test "tiller complete --help shows verification options" {
  run $TILLER complete --help
  [ "$status" -eq 0 ]
  [[ "$output" =~ "complete" ]]
  [[ "$output" =~ "--skip-verify" ]]
}
