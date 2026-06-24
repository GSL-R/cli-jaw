#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/arona-runtime-profile.sh [--target <cli-jaw-install-dir>] [--apply]

Audits optional or unused runtime packages in a cli-jaw install tree.
By default this is a dry run. Pass --apply to remove the listed packages.

This profile is intended for Arona-style deployments that primarily use agy,
codex, and optionally opencode. Removing these packages disables the matching
provider/runtime features:

  jawcode, @jawcode-dev, @oven, bun  -> disables jwc runtime
  claude-e                          -> disables Claude-E runtime
  @bitkyc08                         -> disables AI-E runtime

The script never removes agy, codex, opencode, sqlite, memory files, prompts,
or user data.
USAGE
}

apply=0
target="${CLI_JAW_INSTALL_DIR:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      apply=1
      shift
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --target requires a path" >&2
        exit 2
      fi
      target="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$target" ]]; then
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$npm_root" ]]; then
    target="$npm_root/cli-jaw"
  fi
fi

if [[ -z "$target" || ! -d "$target/node_modules" ]]; then
  echo "ERROR: cli-jaw install tree not found. Pass --target <dir>." >&2
  exit 1
fi

declare -a candidates=(
  "node_modules/jawcode|jwc runtime package"
  "node_modules/@jawcode-dev|jwc native package"
  "node_modules/@oven|bun platform package used by jwc"
  "node_modules/bun|bun package used by jwc"
  "node_modules/claude-e|Claude-E optional runtime"
  "node_modules/@bitkyc08|AI-E optional runtime"
)

echo "Target: $target"
if [[ "$apply" -eq 1 ]]; then
  echo "Mode: APPLY"
else
  echo "Mode: DRY RUN"
fi
echo

found=0
for item in "${candidates[@]}"; do
  rel="${item%%|*}"
  reason="${item#*|}"
  path="$target/$rel"
  if [[ ! -e "$path" ]]; then
    continue
  fi
  found=1
  size="$(du -sh "$path" 2>/dev/null | awk '{print $1}')"
  echo "- $rel ($size): $reason"
  if [[ "$apply" -eq 1 ]]; then
    rm -rf "$path"
    echo "  removed"
  fi
done

if [[ "$found" -eq 0 ]]; then
  echo "No optional runtime packages from this profile were found."
  exit 0
fi

if [[ "$apply" -ne 1 ]]; then
  echo
  echo "Dry run only. Re-run with --apply after confirming those runtimes are unused."
fi
