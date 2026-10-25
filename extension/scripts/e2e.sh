#!/bin/sh
# End-to-end test in a real VS Code with a throwaway profile and a copy of samples/.
set -e
cd "$(dirname "$0")/.."
CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
TMP="$(mktemp -d)"
cp samples/* "$TMP/"
cp -R test/fixtures/ws "$TMP/ws"
(cd "$TMP" && git init -q && git add -A && git -c user.email=e2e@example.invalid -c user.name=e2e commit -qm init)
"$CODE" --user-data-dir "$TMP/.ud" --extensions-dir "$TMP/.ext" --disable-workspace-trust --skip-welcome --new-window \
  --extensionDevelopmentPath="$PWD" --extensionTestsPath="$PWD/out/test/e2e/index.js" "$TMP"
