import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { parse as parseYaml } from "yaml";
import { call, createOctokit, parseRepository } from "../lib/octokit.js";
import { execute, isMain } from "../lib/run.js";

const DEFAULT_REPOSITORY = "spring-io/release-train";

/**
 * The text of a file of a branch, or undefined if the branch has no such file.
 */
async function readFile(octokit, { owner, repo }, branch, file) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: file,
      ref: branch,
    });
    if (Array.isArray(data) || data.type !== "file") {
      throw new Error(`${file} of ${branch} is not a file`);
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Reads the release train of a branch (named after its date, like 2026.11.19) from the
 * release train repository: its release-versions.json, the versions of every project in
 * the train, and its train.yml, the state of the train.
 *
 * A train that has not been created (the branch does not exist) is not an error: there
 * is simply no data, and found is false. Everything else that goes wrong is an error,
 * most of all a repository that cannot be read, because that is a mistake of the
 * token or the name, and would look like a train that is not there.
 */
export async function run({ repository, branch }, { octokit }) {
  const target = parseRepository(repository);
  if (!branch) {
    throw new Error("The input branch is required");
  }

  // The repository first: a repository that cannot be read must not look like a
  // branch that is not there (GitHub answers 404 to both).
  await call(
    `Reading ${repository}`,
    octokit.rest.repos.get({ owner: target.owner, repo: target.repo }),
  );

  let branchExists = true;
  try {
    await octokit.rest.repos.getBranch({ ...target, branch });
  } catch (error) {
    if (error.status !== 404) {
      throw new Error(
        `Reading the branch ${branch} of ${repository} failed with ${error.status} ${error.message}`,
      );
    }
    branchExists = false;
  }
  if (!branchExists) {
    return { found: false, releaseVersions: {}, train: {} };
  }

  const versionsText = await call(
    `Reading release-versions.json of ${branch} of ${repository}`,
    readFile(octokit, target, branch, "release-versions.json"),
  );
  if (versionsText === undefined) {
    throw new Error(
      `The branch ${branch} of ${repository} has no release-versions.json`,
    );
  }
  const trainText = await call(
    `Reading train.yml of ${branch} of ${repository}`,
    readFile(octokit, target, branch, "train.yml"),
  );
  if (trainText === undefined) {
    throw new Error(`The branch ${branch} of ${repository} has no train.yml`);
  }

  let releaseVersions;
  try {
    releaseVersions = JSON.parse(versionsText);
  } catch (error) {
    throw new Error(
      `release-versions.json of ${branch} of ${repository} is not JSON: ${error.message}`,
    );
  }
  let train;
  try {
    train = parseYaml(trainText);
  } catch (error) {
    throw new Error(
      `train.yml of ${branch} of ${repository} is not YAML: ${error.message}`,
    );
  }
  return { found: true, releaseVersions, train: train ?? {} };
}

/**
 * Writes the two files as JSON in a directory, and returns their paths. The data is also
 * an output of the action, but a train can be large (hundreds of releases), and the
 * input of another action is an environment variable, which has a size limit on Linux.
 * The files have no limit.
 */
export function writeFiles(directory, { releaseVersions, train }) {
  fs.mkdirSync(directory, { recursive: true });
  const releaseVersionsFile = path.join(directory, "release-versions.json");
  const trainFile = path.join(directory, "train.json");
  fs.writeFileSync(
    releaseVersionsFile,
    JSON.stringify(releaseVersions, null, 2) + "\n",
  );
  fs.writeFileSync(trainFile, JSON.stringify(train, null, 2) + "\n");
  return { releaseVersionsFile, trainFile };
}

export async function main() {
  const repository =
    core.getInput("release-train-repository") || DEFAULT_REPOSITORY;
  const branch = core.getInput("branch", { required: true });
  const directory =
    core.getInput("output-directory") ||
    fs.mkdtempSync(
      path.join(process.env.RUNNER_TEMP || os.tmpdir(), "release-train-"),
    );
  const octokit = createOctokit({ token: core.getInput("token") });

  const result = await run({ repository, branch }, { octokit });
  const { releaseVersionsFile, trainFile } = writeFiles(directory, result);
  if (result.found) {
    core.info(
      `Read the release train ${branch} of ${repository}: ${Object.keys(result.releaseVersions).length} projects`,
    );
  } else {
    core.info(
      `The release train ${branch} does not exist in ${repository} (it has not been created): no data`,
    );
  }
  core.setOutput("found", String(result.found));
  core.setOutput("release-versions", JSON.stringify(result.releaseVersions));
  core.setOutput("train", JSON.stringify(result.train));
  core.setOutput("release-versions-file", releaseVersionsFile);
  core.setOutput("train-file", trainFile);
}

if (isMain(import.meta.url)) {
  execute(main);
}
