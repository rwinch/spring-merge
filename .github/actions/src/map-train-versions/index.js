import fs from "node:fs";
import * as core from "@actions/core";
import { parseBoolean } from "../lib/inputs.js";
import { execute, isMain } from "../lib/run.js";
import { readVersions } from "../lib/toml.js";
import {
  compareVersions,
  generationOf,
  isHotfix,
  withoutQualifier,
} from "../lib/versions.js";

const newest = (versions) =>
  versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));

const generationOrNull = (version) => {
  try {
    return generationOf(version);
  } catch {
    return null;
  }
};

/**
 * Works out which versions of a version catalog the release train asks to change, and to
 * what. The catalog names a version after the project of the train that releases it:
 * `spring-framework = "7.0.9"` is the version of the project `spring-framework`, whose
 * versions the train lists in releaseVersions.
 *
 * For every version of the catalog that is a project of the train:
 *
 * - the train versions of the same generation (the first two numbers) are the candidates.
 *   None: it is left alone.
 * - the newest of them is chosen, but a hotfix (7.0.10.1) only if preferHotfix is true
 *   and there is one, else the newest that is not a hotfix.
 * - if requireJoined is true, the version must have joined the train (train.yml has its
 *   `joined` commit hash), else it is left alone.
 * - a suffix is added: hotfixSuffix to a hotfix, suffix to the others (-INTERNAL-SNAPSHOT
 *   for example). A milestone or a release candidate is dropped first, a snapshot never
 *   carries one: the snapshot of 7.1.0-RC1 is 7.1.0-SNAPSHOT.
 * - if the catalog has that version already (with the suffix), it is updated already, and
 *   left alone, and so it is if it has the version of the train itself and a suffix is
 *   asked for. If the catalog has a newer version than the train, it fails.
 *
 * It returns the versions to change as an object from the name to the new version, and the
 * lines to log, what it did for every version of the train.
 */
export function mapVersions({
  releaseVersions,
  train,
  versions,
  preferHotfix = false,
  requireJoined = true,
  suffix = "",
  hotfixSuffix = "",
}) {
  if (requireJoined && !train) {
    throw new Error(
      "The train (train.yml) is needed to tell which versions have joined: give it, or set require-joined to false",
    );
  }
  const changes = {};
  const log = [];
  for (const [name, current] of versions) {
    if (!Object.hasOwn(releaseVersions, name)) {
      continue; // not a project of the train
    }
    const generation = generationOf(current);
    const candidates = releaseVersions[name].filter(
      (version) => generationOrNull(version) === generation,
    );
    const hotfixes = candidates.filter(isHotfix);
    const others = candidates.filter((version) => !isHotfix(version));
    const hotfix = preferHotfix && hotfixes.length > 0;
    const pool = hotfix ? hotfixes : others;
    if (pool.length === 0) {
      log.push(
        `${name} ${current}: the train has no version of ${generation} to go to, left alone`,
      );
      continue;
    }
    const chosen = newest(pool);

    if (requireJoined) {
      const joined =
        train.releases?.[name]?.[chosen]?.["commit-hashes"]?.joined;
      if (!joined) {
        log.push(
          `${name} ${current}: ${chosen} has not joined the train, left alone`,
        );
        continue;
      }
    }

    // The catalog is compared with the version of the train, and not with its snapshot:
    // a snapshot is a step forward from the milestone before it (7.1.0-M1 to the
    // snapshot of 7.1.0-RC1), though it sorts below the milestones of its version.
    const order = compareVersions(current, chosen);
    if (order > 0) {
      throw new Error(
        `${name} is ${current}, which is newer than the ${chosen} of the train`,
      );
    }
    const added = hotfix ? hotfixSuffix : suffix;
    const version = added ? withoutQualifier(chosen) + added : chosen;
    if (version === current) {
      log.push(`${name} ${current}: already ${version}, left alone`);
      continue;
    }
    if (order === 0) {
      // The version of the train itself, and a snapshot of it is asked for: it has been
      // released already, there is nothing to take a snapshot of.
      log.push(
        `${name} ${current}: already the ${chosen} of the train, left alone`,
      );
      continue;
    }
    changes[name] = version;
    log.push(`${name} ${current}: to ${version}`);
  }
  return { changes, log };
}

function readJson(what, file, text) {
  if (file) {
    if (!fs.existsSync(file)) {
      throw new Error(`The file of ${what} does not exist: ${file}`);
    }
    text = fs.readFileSync(file, "utf8");
  }
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} is not JSON: ${error.message}`);
  }
}

export async function main() {
  const releaseVersions = readJson(
    "release-versions",
    core.getInput("release-versions-file"),
    core.getInput("release-versions"),
  );
  if (!releaseVersions) {
    throw new Error(
      "The input release-versions-file (or release-versions) is required",
    );
  }
  const train = readJson(
    "train",
    core.getInput("train-file"),
    core.getInput("train"),
  );
  const tomlPath = core.getInput("toml-path") || "gradle/libs.versions.toml";
  if (!fs.existsSync(tomlPath)) {
    throw new Error(`The version catalog does not exist: ${tomlPath}`);
  }
  const { changes, log } = mapVersions({
    releaseVersions,
    train,
    versions: readVersions(fs.readFileSync(tomlPath, "utf8")),
    preferHotfix: parseBoolean(
      "prefer-hotfix",
      core.getInput("prefer-hotfix"),
      false,
    ),
    requireJoined: parseBoolean(
      "require-joined",
      core.getInput("require-joined"),
      true,
    ),
    suffix: core.getInput("suffix"),
    hotfixSuffix: core.getInput("hotfix-suffix"),
  });
  log.forEach((line) => core.info(line));
  core.info(`${Object.keys(changes).length} versions to change`);
  core.setOutput("versions", JSON.stringify(changes));
  core.setOutput("count", String(Object.keys(changes).length));
}

if (isMain(import.meta.url)) {
  execute(main);
}
