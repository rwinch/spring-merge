#!/usr/bin/env bash
#
# Decides what the push of a disclosure branch builds. The workflow release-branches.yml
# runs it, and it can be run by hand:
#
#   REF_NAME=disclosure/frozen/7.0.x VERSION=7.0.1-SNAPSHOT .github/scripts/plan.sh
#
# Input (environment):
#   REF_NAME   the pushed branch: disclosure/frozen/<generation> or disclosure/active/<generation>
#   VERSION    the version of gradle.properties on it, <version>-SNAPSHOT
#
# Output, one name=value per line on standard output (the workflow adds them to
# GITHUB_OUTPUT), and what it decided on standard error:
#
#   release           false if there is nothing to build, which is only for a version that ends
#                     with .0 on an active disclosure: it is not a patch release, so it has
#                     no hotfix
#   kind              frozen or active
#   base-version      the snapshot version that the release version is worked out from:
#                     the version of the frozen branch (7.0.1-SNAPSHOT), or the hotfix
#                     version of an active one (7.0.1.1-SNAPSHOT)
#   hotfix            true for an active disclosure: a hotfix is built, and hotfix versions
#                     of the dependencies are preferred
#   snapshot-branch   the branch of the snapshot version that the release branch is based on
#                     (active) or that is thrown away (frozen):
#                       frozen   disclosure/7.0.1-INTERNAL-SNAPSHOT
#                       active   disclosure/7.0.1.1-SNAPSHOT
#   snapshot-version  the version of that branch: 7.0.1-INTERNAL-SNAPSHOT, 7.0.1.1-SNAPSHOT.
#                     A snapshot never carries a milestone or a release candidate, so it is
#                     the version of the branch with -SNAPSHOT replaced, and not the release.
#                     A hotfix never has an internal snapshot.

set -euo pipefail

REF_NAME=${REF_NAME:?REF_NAME is required, for example disclosure/frozen/7.0.x}
VERSION=${VERSION:?VERSION is required, for example 7.0.1-SNAPSHOT}

fail() {
	echo "::error::$*" >&2
	exit 1
}

case "$REF_NAME" in
disclosure/frozen/*) kind=frozen ;;
disclosure/active/*) kind=active ;;
*) fail "$REF_NAME is not a disclosure branch: expected disclosure/frozen/* or disclosure/active/*" ;;
esac

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?-SNAPSHOT$ ]]; then
	fail "$REF_NAME has the version $VERSION: expected <major>.<minor>.<patch>-SNAPSHOT"
fi
plain=${VERSION%-SNAPSHOT}
hotfix_format='^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'

if [ "$kind" = frozen ]; then
	if [[ "$plain" =~ $hotfix_format ]]; then
		fail "$REF_NAME has the version $VERSION, a hotfix: only an active disclosure has one, and a hotfix has no internal snapshot"
	fi
	echo "$REF_NAME is a frozen disclosure: the release of $VERSION, and the internal snapshot of it" >&2
	echo "release=true"
	echo "kind=frozen"
	echo "base-version=$VERSION"
	echo "hotfix=false"
	echo "snapshot-branch=disclosure/$plain-INTERNAL-SNAPSHOT"
	echo "snapshot-version=$plain-INTERNAL-SNAPSHOT"
	exit 0
fi

# An active disclosure.
if [[ "$plain" =~ $hotfix_format ]]; then
	fail "$REF_NAME has the version $VERSION, which is a hotfix already: an active disclosure has the version of the release that it fixes"
fi
if [[ "$plain" == *.0 ]]; then
	echo "$REF_NAME has the version $VERSION, which is not a patch release: it has no hotfix, so there is nothing to build" >&2
	echo "release=false"
	echo "kind=active"
	exit 0
fi
hotfix=$plain.1
echo "$REF_NAME is an active disclosure: the hotfix $hotfix of $VERSION" >&2
echo "release=true"
echo "kind=active"
echo "base-version=$hotfix-SNAPSHOT"
echo "hotfix=true"
echo "snapshot-branch=disclosure/$hotfix-SNAPSHOT"
echo "snapshot-version=$hotfix-SNAPSHOT"
