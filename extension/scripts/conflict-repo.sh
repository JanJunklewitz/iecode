#!/bin/sh
# Creates a git repo with a merge conflict in samples/FB_Motor.TcPOU (body, <LineIds> and FolderPath of Start).
# Usage: conflict-repo.sh <target-dir>   (the directory must not exist or be empty)
set -e
[ -n "$1" ] || { echo "usage: $0 <target-dir>" >&2; exit 2; }
SRC="$(cd "$(dirname "$0")/.." && pwd)/samples/FB_Motor.TcPOU"
mkdir -p "$1"
cd "$1"
g() { git -c core.autocrlf=false -c user.name=iecode -c user.email=iecode@example.invalid "$@"; }
g init -q -b main
# the repo's own rules don't follow the copied file: keep the CRLF bytes
printf '*.TcPOU -text\n' > .gitattributes
cp "$SRC" FB_Motor.TcPOU
g add -A
g commit -q -m base
# edit the Start method in place; sed keeps the CRLF line ends
edit() {
  sed -e "s/^Start := TRUE;/Start := $1;/" \
      -e "/LineIds Name=\"FB_Motor.Start\"/{n;s/Id=\"2\" Count=\"2\"/Id=\"$2\" Count=\"2\"/;}" \
      -e "s/Name=\"Start\" \(Id=\"[^\"]*\"\) FolderPath=\"Internal\\\\\"/Name=\"Start\" \1 FolderPath=\"$3\\\\\"/" \
      FB_Motor.TcPOU > FB_Motor.tmp
  mv FB_Motor.tmp FB_Motor.TcPOU
}
g checkout -q -b a
edit 'TRUE AND FALSE' 20 'FolderA'
g commit -q -am a
g checkout -q main
g checkout -q -b b
edit 'NOT FALSE' 30 'FolderB'
g commit -q -am b
g checkout -q a
g merge b >/dev/null 2>&1 || true
echo "$1"
