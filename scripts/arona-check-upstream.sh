#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! git remote get-url upstream >/dev/null 2>&1; then
    echo "Missing upstream remote. Add lidge-jun/cli-jaw as upstream first." >&2
    exit 1
fi

git fetch upstream --prune --tags --quiet

if git rev-parse --verify upstream/main >/dev/null 2>&1; then
    stable_ref="upstream/main"
elif git rev-parse --verify upstream/master >/dev/null 2>&1; then
    stable_ref="upstream/master"
else
    echo "Missing upstream stable branch (main or master)." >&2
    exit 1
fi

installed="$(npm list -g cli-jaw --depth=0 --json 2>/dev/null | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    process.stdout.write(parsed.dependencies?.["cli-jaw"]?.version || "not installed");
  } catch {
    process.stdout.write("unknown");
  }
});
')"

echo "== Package channels =="
printf "installed: %s\n" "$installed"
timeout 20s npm view cli-jaw dist-tags --json 2>/dev/null || echo "npm registry unavailable or timed out"

echo
echo "== Upstream branch heads =="
for ref in "$stable_ref" upstream/dev upstream/preview; do
    if git rev-parse --verify "$ref" >/dev/null 2>&1; then
        git show -s --format="$ref%n  %H%n  %cI%n  %s" "$ref"
    fi
done

echo
echo "== Newest version-like tags =="
git tag --sort=-version:refname | head -10

echo
echo "== Recently active upstream branches =="
git for-each-ref \
    --sort=-committerdate \
    --count=10 \
    --format='%(committerdate:iso8601)  %(refname:short)  %(objectname:short)  %(subject)' \
    refs/remotes/upstream \
    | grep -v 'upstream/HEAD' || true

echo
echo "== Unreleased preview commits after stable branch =="
git log --oneline --decorate --no-merges "$stable_ref"..upstream/preview -20

echo
echo "== Preview change summary =="
git diff --shortstat "$stable_ref"...upstream/preview

echo
echo "== Local runtime commits after stable branch =="
git log --oneline --decorate "$stable_ref"..arona-runtime 2>/dev/null || true
