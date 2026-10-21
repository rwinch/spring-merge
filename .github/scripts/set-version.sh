#!/usr/bin/env bash
#
# Sets the version of gradle.properties and commits it, as a commit of its own, signed
# off with the identity that git is set up with:
#
#   set-version.sh <version> <message>
#   set-version.sh 7.0.1 "Release 7.0.1"
#
# Only the line version=... changes: the other properties of the file, and its line
# endings, stay. It fails if the file has no such line, or if the version is already that
# (there would be nothing to commit).

set -euo pipefail

version=${1:?usage: set-version.sh <version> <message>}
message=${2:?usage: set-version.sh <version> <message>}
file=gradle.properties

fail() {
	echo "::error::$*" >&2
	exit 1
}

[[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]] || fail "$version is not a version to write"
[ -f "$file" ] || fail "$file does not exist, in $(pwd)"
grep -q '^version=' "$file" || fail "$file has no line version=..."
if [ "$(sed -n 's/^version=\([^\r]*\).*/\1/p' "$file")" = "$version" ]; then
	fail "$file has the version $version already, there is nothing to commit"
fi
# git must have been told who commits: without it, git makes an identity up from the name of
# the user and of the machine (runner@fv-az123).
git -c user.useConfigOnly=true var GIT_COMMITTER_IDENT >/dev/null 2>&1 ||
	fail "git does not know who commits: set user.name and user.email (git config)"

# perl, not sed -i, which is not the same on macOS and on Linux. The line ending is kept.
VERSION="$version" perl -pi -e 's/^version=[^\r\n]*/version=$ENV{VERSION}/' "$file"

git add -- "$file"
git -c commit.gpgsign=false commit --quiet --signoff --message "$message" -- "$file"
echo "$(git rev-parse --short HEAD) $message"
