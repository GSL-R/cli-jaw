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

Runtime identity prompts, diaries, credentials, local paths, and private
automation are intentionally excluded from this fork.

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

