#!/usr/bin/env bash
# Regression probes for the Bun YAML-based smarty-dev#1246 guard.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$repo_root/scripts/ci/no-hosted-runners.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf -- "$fixture_dir"' EXIT

bash "$guard" "$repo_root/.github/workflows"
echo "PASS: real workflows"

expect_rejected() {
  local name="$1" content="$2" diagnostic="${3:-unapproved hosted runner}" output
  printf '%s\n' "$content" > "$fixture_dir/probe.yml"
  if output="$(bash "$guard" "$fixture_dir" 2>&1)"; then
    echo "FAIL: $name was accepted" >&2
    exit 1
  fi
  if [[ "$output" != *"$diagnostic"* ]]; then
    printf 'FAIL: %s failed without the expected diagnostic:\n%s\n' "$name" "$output" >&2
    exit 1
  fi
  echo "PASS: rejected $name"
}

expect_accepted() {
  local name="$1" content="$2"
  printf '%s\n' "$content" > "$fixture_dir/probe.yml"
  bash "$guard" "$fixture_dir"
  echo "PASS: accepted $name"
}

expect_rejected 'bare exception marker' $'jobs:\n  check:\n    # hosted-exception:\n    runs-on: ubuntu-latest'
expect_rejected 'folded hosted runs-on' $'jobs:\n  check:\n    runs-on: >-\n      ubuntu-latest'
expect_rejected 'plain hosted runs-on' $'jobs:\n  check:\n    runs-on: ubuntu-latest'
expect_rejected 'inline hosted list' $'jobs:\n  check:\n    runs-on: [self-hosted, ubuntu-latest]'
expect_rejected 'hosted matrix list' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner:\n          - windows-latest\n    runs-on: ${{ matrix.runner }}'
expect_rejected 'matrix list item as folded scalar (Astra round 3)' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner:\n          - >-\n            ubuntu-latest\n    runs-on: ${{ matrix.runner }}'
expect_rejected 'quoted runs-on folded scalar (Astra round 3)' $'jobs:\n  check:\n    "runs-on": >-\n      ubuntu-latest'

# Retain every earlier key/indicator/list-form probe, now as valid runner matrices.
for key in runs-on runner os; do
  for indicator in '>' '>-' '>+' '|' '|-' '|+'; do
    expect_rejected "matrix.$key $indicator scalar list" "jobs:
  check:
    strategy:
      matrix:
        $key:
          - $indicator
            ubuntu-latest
    runs-on: \${{ matrix.$key }}"
    expect_rejected "matrix.runners.$key $indicator object list" "jobs:
  check:
    strategy:
      matrix:
        runners:
          - $key: $indicator
              ubuntu-latest
    runs-on: \${{ matrix.runners.$key }}"
  done
done

expect_rejected 'hosted matrix include' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner: [smarty-linux-x64]\n        include:\n          - runner: macos-latest\n    runs-on: ${{ matrix.runner }}'
expect_rejected 'hosted include-only nested runner' $'jobs:\n  check:\n    strategy:\n      matrix:\n        include:\n          - target: {runner: windows-2025}\n    runs-on: ${{ matrix.target.runner }}'
expect_rejected 'hosted object labels' $'jobs:\n  check:\n    runs-on: {group: forge, labels: [self-hosted, ubuntu-24.04]}'
expect_rejected 'unresolvable inputs expression' $'jobs:\n  check:\n    runs-on: ${{ inputs.x }}' 'unresolvable runner'
expect_rejected 'unresolvable matrix path' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner: [smarty-linux-x64]\n    runs-on: ${{ matrix.missing }}' 'unresolvable runner'
expect_rejected 'dynamic matrix' $'jobs:\n  check:\n    strategy:\n      matrix: ${{ fromJSON(inputs.matrix) }}\n    runs-on: ${{ matrix.runner }}' 'unresolvable runner'
expect_rejected 'non-string runner' $'jobs:\n  check:\n    runs-on: 42' 'unresolvable runner'
expect_rejected 'non-string resolved matrix value' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner: [[smarty-linux-x64]]\n    runs-on: ${{ matrix.runner }}' 'unresolvable runner'
expect_rejected 'unsupported runner mapping' $'jobs:\n  check:\n    runs-on: {unknown: smarty-linux-x64}' 'unresolvable runner'
expect_rejected 'invalid YAML' $'jobs:\n  check:\n    runs-on: [smarty-linux-x64' 'invalid YAML'
expect_rejected 'include overwrites added runner with hosted value' $'jobs:\n  check:\n    strategy:\n      matrix:\n        target: [linux]\n        include:\n          - runner: smarty-linux-x64\n          - runner: ubuntu-latest\n    runs-on: ${{ matrix.runner }}'
expect_rejected 'include entry missing referenced runner' $'jobs:\n  check:\n    strategy:\n      matrix:\n        include:\n          - runner: smarty-linux-x64\n          - target: linux\n    runs-on: ${{ matrix.runner }}' 'unresolvable runner'
expect_rejected 'expression inside resolved matrix string' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner: ["${{ inputs.x }}"]\n    runs-on: ${{ matrix.runner }}' 'unresolvable runner'
expect_rejected 'non-string label list item' $'jobs:\n  check:\n    runs-on: [smarty-linux-x64, false]' 'unresolvable runner'
expect_rejected 'empty label list' $'jobs:\n  check:\n    runs-on: []' 'unresolvable runner'
expect_rejected 'missing runs-on' $'jobs:\n  check:\n    steps: []' 'unresolvable runner'
expect_rejected 'hosted runner in second job' $'jobs:\n  safe:\n    runs-on: smarty-linux-x64\n  hosted:\n    runs-on: macos-latest'
expect_rejected 'reusable hosted runs-on input' $'jobs:\n  check:\n    uses: ./reusable.yml\n    with:\n      runs-on: ubuntu-latest'
expect_rejected 'reusable hosted matrix input' $'jobs:\n  check:\n    uses: ./reusable.yml\n    strategy:\n      matrix:\n        runner: [windows-latest]\n    with:\n      runs-on: ${{ matrix.runner }}'

expect_accepted 'smarty-linux-x64 fixture' $'jobs:\n  check:\n    runs-on: smarty-linux-x64'
expect_accepted 'smarty-linux-x64 via matrix' $'jobs:\n  check:\n    strategy:\n      matrix:\n        runner: [smarty-linux-x64]\n    runs-on: ${{ matrix.runner }}'
expect_accepted 'self-hosted labels/group and nested matrix include' $'jobs:\n  check:\n    strategy:\n      matrix:\n        include:\n          - target: {runner: smarty-linux-x64}\n    runs-on: {group: forge, labels: [self-hosted, "${{ matrix.target.runner }}"]}'
expect_accepted 'self-hosted folded scalar and quoted key' $'jobs:\n  check:\n    "runs-on": >-\n      smarty-linux-x64'
expect_accepted 'matrix include augmentation and exclude' $'jobs:\n  check:\n    strategy:\n      matrix:\n        target: [linux, mac]\n        runner: [smarty-linux-x64, ubuntu-latest]\n        exclude:\n          - runner: ubuntu-latest\n        include:\n          - target: linux\n            suffix: x64\n          - target: mac\n            suffix: x64\n    runs-on: ${{ matrix.runner }}-${{ matrix.suffix }}'
expect_accepted 'reusable self-hosted input' $'jobs:\n  check:\n    uses: ./reusable.yml\n    with:\n      runs-on: smarty-linux-x64'
expect_accepted 'reusable without runner input' $'jobs:\n  check:\n    uses: ./reusable.yml'
expect_accepted 'self-hosted group-only runner' $'jobs:\n  check:\n    runs-on: {group: forge}'
expect_accepted 'hosted-looking step text and unused matrix value' $'jobs:\n  check:\n    strategy:\n      matrix:\n        artifact: [ubuntu-latest]\n    runs-on: smarty-linux-x64\n    steps:\n      - run: echo ubuntu-latest'
expect_accepted 'reusable unresolved input ignored' $'jobs:\n  check:\n    uses: ./reusable.yml\n    with:\n      runs-on: ${{ inputs.x }}'
expect_accepted 'reusable unrelated hosted-looking input ignored' $'jobs:\n  check:\n    uses: ./reusable.yml\n    with:\n      artifact: ubuntu-latest'

rm -- "$fixture_dir/probe.yml"
if bash "$guard" "$fixture_dir" >/dev/null 2>&1; then
  echo 'FAIL: empty workflow directory was accepted' >&2
  exit 1
fi
echo 'PASS: rejected empty workflow directory'
printf '%s\n' $'jobs:\n  check:\n    runs-on: smarty-linux-x64' > "$fixture_dir/probe.yaml"
bash "$guard" "$fixture_dir"
echo 'PASS: accepted .yaml workflow'
expect_rejected 'hosted .yml beside safe .yaml workflow' $'jobs:\n  check:\n    runs-on: ubuntu-latest'
expect_rejected 'invalid YAML beside safe workflow' $'jobs:\n  check:\n    runs-on: [' 'invalid YAML'
echo "All hosted-runner guard probes passed"
