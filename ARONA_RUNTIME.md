# ARONA Runtime Branch

This fork preserves reviewed runtime fixes without disconnecting from
`lidge-jun/cli-jaw`.

## Branch Policy

- `master`: mirror the upstream stable branch. Do not add local patches here.
- `arona-runtime`: the currently reviewed stable base plus local runtime fixes.
- `fix/*`: one upstream-ready fix per branch. Open pull requests from these
  branches, not from `arona-runtime`.

## Patch Inventory

The current `arona-runtime` branch is based on cli-jaw 2.1.5 and carries:

1. The upstream preview fix for issue #245, cherry-picked as a source commit.
2. Antigravity transcript progress and bounded checkpoint-stall handling.
3. Telegram-supported HTML preservation with unsafe raw tags escaped.
4. Honest AGY quota rendering when the provider exposes binary availability
   instead of a precise remaining fraction.
5. Explicit AGY transcript provider-error propagation from upstream issue
   #246, while preserving successful recovery after transient errors.
6. A bounded, read-only pre-prompt context hook for injecting allowlisted JSON
   runtime state, with TTLs, character budgets, a kill switch, and an inspect
   command.

Runtime identity prompts, diaries, credentials, local paths, and private
automation are intentionally excluded from this fork.

## Pre-Prompt Context Hook

The hook is disabled unless `~/.cli-jaw/context-hooks.json` exists. It never
executes commands: it only reads explicitly registered JSON files below
`CLI_JAW_HOME` and injects allowlisted fields as untrusted runtime data.

Inspect the exact block before enabling or changing a source:

```bash
jaw hooks inspect --scope main --cli agy --fresh
jaw hooks inspect --scope heartbeat --job ac-guard --cli agy
```

Set `CLI_JAW_PRE_PROMPT_HOOKS=0` to disable all hook injection immediately.
Configuration and threat-model details are in
`docs/dev/pre-prompt-context-hooks.md`.

## Deploying the Runtime Branch

The live installation keeps its existing dependency tree. This avoids a full
global npm reinstall restoring optional provider packages that were removed
from the ARONA host.

```bash
npm run build
tar -czf ~/.cli-jaw/backups/runtime-install/cli-jaw-before-runtime-sync.tar.gz \
  -C "$(npm root -g)" cli-jaw
cp -a dist/. "$(npm root -g)/cli-jaw/dist/"
pm2 restart jaw-server
jaw hooks inspect --scope main --cli agy
```

Rebuild and copy the complete `dist` tree after every source update. Copying
only remembered files risks leaving generated imports out of sync. A full npm
reinstall remains appropriate for dependency changes, but must be followed by
the documented optional-provider cleanup audit.

## Checking Upstream

Run:

```bash
scripts/arona-check-upstream.sh
```

The report distinguishes four signals that can move independently:

- the installed global package version;
- the npm `latest` and `next` dist-tags;
- the upstream stable `master` branch and release tags;
- unreleased work on `preview`, `dev`, and feature branches.

A moving `preview` branch or preview tag is evidence of development, not a
production update. Review an explicit commit or version, compare the relevant
files, and run focused tests before changing the live installation.

## Updating the Fork

```bash
git fetch upstream --prune --tags
git switch master
git merge --ff-only upstream/master
git push origin master
git switch arona-runtime
git rebase master
```

During the rebase, drop a local patch when upstream provides an equivalent
tested implementation. Never resolve a conflict by restoring an old generated
`dist/` file over newer source.
