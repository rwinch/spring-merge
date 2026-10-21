// Versions as the Spring projects write them: numbers separated by dots, and maybe a
// qualifier.
//
//   7.0.10            a release            2025.0.8        a calendar version (Reactor)
//   7.0.10.1          a hotfix             7.1.0-M2        a milestone
//   7.1.0-RC1         a release candidate  7.0.10-SNAPSHOT a snapshot
//   7.0.10-INTERNAL-SNAPSHOT               a snapshot that is only for the train

const VERSION =
  /^(\d+(?:\.\d+)+)(?:-(SNAPSHOT|INTERNAL-SNAPSHOT|M(\d+)|RC(\d+)))?$/;

// The order of the qualifiers of one version: a snapshot, its milestones, its release
// candidates, and then the version itself.
const SNAPSHOT = 0;
const MILESTONE = 1;
const CANDIDATE = 2;
const RELEASE = 3;

/**
 * Reads a version: its numbers, and the kind of its qualifier with its number. Throws if
 * it is not a version of this form (1.0.18.RELEASE is not).
 */
export function parseVersion(text) {
  const match = VERSION.exec(text ?? "");
  if (!match) {
    throw new Error(
      `Cannot read "${text}" as a version: expected numbers separated by dots, then maybe -M<n>, -RC<n>, -SNAPSHOT or -INTERNAL-SNAPSHOT`,
    );
  }
  const numbers = match[1].split(".").map(Number);
  if (match[2] === undefined) {
    return { numbers, kind: RELEASE, qualifier: 0 };
  }
  if (match[3] !== undefined) {
    return { numbers, kind: MILESTONE, qualifier: Number(match[3]) };
  }
  if (match[4] !== undefined) {
    return { numbers, kind: CANDIDATE, qualifier: Number(match[4]) };
  }
  return { numbers, kind: SNAPSHOT, qualifier: 0 };
}

/**
 * Compares two versions: negative if a is older than b, positive if newer, 0 if the same.
 * The numbers are compared one by one, a missing number is 0 (7.0.10 is older than
 * 7.0.10.1). If they are the same, the qualifiers decide: a snapshot (SNAPSHOT and
 * INTERNAL-SNAPSHOT are the same) is older than the milestones of a version, which are
 * older than its release candidates, which are older than the version itself.
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const length = Math.max(x.numbers.length, y.numbers.length);
  for (let i = 0; i < length; i++) {
    const difference = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return x.kind - y.kind || x.qualifier - y.qualifier;
}

/**
 * The generation of a version, its first two numbers: 7.0 for 7.0.10.1, and 2025.0 for
 * 2025.0.8. It does not need the whole version to be readable.
 */
export function generationOf(text) {
  const match = /^(\d+)\.(\d+)(?:\.|-|$)/.exec(text ?? "");
  if (!match) {
    throw new Error(
      `Cannot get the generation of "${text}": expected <major>.<minor>...`,
    );
  }
  return `${match[1]}.${match[2]}`;
}

/** A hotfix has four numbers: 7.0.10.1. */
export function isHotfix(text) {
  return parseVersion(text).numbers.length === 4;
}

/**
 * The version without its milestone or release candidate: a snapshot of 7.1.0-RC1 is
 * 7.1.0-SNAPSHOT, because a snapshot never carries M or RC.
 */
export function withoutQualifier(text) {
  const { numbers, kind } = parseVersion(text);
  return kind === MILESTONE || kind === CANDIDATE
    ? numbers.join(".")
    : (text ?? "");
}
