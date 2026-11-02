#!/bin/sh
# End-to-end test in a real VS Code with a throwaway profile and a copy of samples/.
# On Windows: CODE="$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" sh scripts/e2e.sh
set -e
cd "$(dirname "$0")/.."
CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
TMP="$(mktemp -d)"
cp samples/* "$TMP/"
cp test/fixtures/visu/* "$TMP/"
cp -R test/fixtures/ws "$TMP/ws"
(cd "$TMP" && git init -q && git add -A && git -c user.email=e2e@example.invalid -c user.name=e2e commit -qm init)
# merge conflict in a nested repo; the outer repo ignores it so its Source Control state stays as the other steps expect
sh scripts/conflict-repo.sh "$TMP/conflict" > /dev/null
echo 'conflict/' >> "$TMP/.git/info/exclude"
# shells started from VS Code set this and Code.exe then fails with "bad option"
unset ELECTRON_RUN_AS_NODE
"$CODE" --user-data-dir "$TMP/.ud" --extensions-dir "$TMP/.ext" --disable-workspace-trust --skip-welcome --new-window \
  --extensionDevelopmentPath="$PWD" --extensionTestsPath="$PWD/out/test/e2e/index.js" "$TMP"
