import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { git, requireIdentity } from "../lib/git.js";
import { parseBoolean } from "../lib/inputs.js";
import { execute, isMain } from "../lib/run.js";
import { readVersions, setVersion } from "../lib/toml.js";

/**
 * The message of the commit of one update. It is not an input: every update reads the
 * same, so that the history of a catalog is the same everywhere.
 *
 *   Update spring-framework to 7.0.10
 *
 *   Closes gh-123
 *
 * A signed-off-by line is added by git, for the identity that is set.
 */
export function commitMessage({ dependency, version, issue }) {
  const lines = [`Update ${dependency} to ${version}`];
  if (issue) {
    lines.push("", `Closes gh-${issue}`);
  }
  return lines.join("\n");
}

/**
 * The updates as a list, in the order of the names, with each one checked. A change is
 * the new version as a string, or `{ version, issue }` (the number of the issue the
 * commit closes).
 */
export function updatesOf(changes, requireIssue) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error(
      "The versions must be an object from the name of a version to its new version, or to { version, issue }",
    );
  }
  return Object.keys(changes)
    .sort()
    .map((dependency) => {
      const change = changes[dependency];
      const { version, issue } =
        typeof change === "string" ? { version: change } : (change ?? {});
      if (!version || typeof version !== "string") {
        throw new Error(`The update of ${dependency} has no version`);
      }
      const hasIssue = issue !== undefined && issue !== null && issue !== "";
      if (hasIssue && !/^[1-9]\d*$/.test(String(issue))) {
        throw new Error(
          `The issue of the update of ${dependency} must be a number, not "${issue}"`,
        );
      }
      if (!hasIssue && requireIssue) {
        throw new Error(
          `The update of ${dependency} has no issue (set require-issue to false to allow that)`,
        );
      }
      return {
        dependency,
        version,
        issue: hasIssue ? String(issue) : undefined,
      };
    });
}

/**
 * Changes the versions of a version catalog in a git repository, with one commit for
 * each, in the order of the names. All of the updates are checked before the first
 * commit, so a name that is wrong does not leave some of them done. A version that has
 * the new version already is left alone, and has no commit.
 *
 * The identity of the commits is the one git is set up with, and they are signed off
 * with it.
 */
export function updateVersions({
  directory,
  tomlPath,
  changes,
  requireIssue = true,
  log = () => {},
}) {
  const updates = updatesOf(changes, requireIssue);
  const file = path.resolve(directory, tomlPath);
  if (!fs.existsSync(file)) {
    throw new Error(`The version catalog does not exist: ${file}`);
  }
  const relative = path.relative(path.resolve(directory), file);
  if (git(directory, "status", "--porcelain", "--", relative)) {
    throw new Error(
      `${tomlPath} has changes that are not committed: the updates would commit them`,
    );
  }

  const known = readVersions(fs.readFileSync(file, "utf8"));
  for (const { dependency } of updates) {
    if (!known.has(dependency)) {
      throw new Error(
        `${tomlPath} has no version ${dependency} (a line of the form ${dependency} = "..." in its [versions] section)`,
      );
    }
  }

  // Before the first change, so that a failure leaves nothing done.
  if (updates.some((u) => known.get(u.dependency) !== u.version)) {
    requireIdentity(directory);
  }

  const commits = [];
  for (const update of updates) {
    const text = fs.readFileSync(file, "utf8");
    if (readVersions(text).get(update.dependency) === update.version) {
      log(`${update.dependency} is ${update.version} already, no commit`);
      continue;
    }
    fs.writeFileSync(file, setVersion(text, update.dependency, update.version));
    git(
      directory,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--signoff",
      "--message",
      commitMessage(update),
      "--",
      relative,
    );
    const commit = git(directory, "rev-parse", "HEAD");
    log(
      `${update.dependency} to ${update.version}: ${commit.slice(0, 7)}${update.issue ? `, closes gh-${update.issue}` : ""}`,
    );
    commits.push({ ...update, commit });
  }
  return commits;
}

export async function main() {
  let changes;
  try {
    changes = JSON.parse(core.getInput("versions", { required: true }));
  } catch (error) {
    throw new Error(`The input versions is not JSON: ${error.message}`);
  }
  const commits = updateVersions({
    directory: core.getInput("path") || ".",
    tomlPath: core.getInput("toml-path") || "gradle/libs.versions.toml",
    changes,
    requireIssue: parseBoolean(
      "require-issue",
      core.getInput("require-issue"),
      true,
    ),
    log: (line) => core.info(line),
  });
  core.info(`${commits.length} commits`);
  core.setOutput("commits", JSON.stringify(commits));
  core.setOutput("count", String(commits.length));
}

if (isMain(import.meta.url)) {
  execute(main);
}
