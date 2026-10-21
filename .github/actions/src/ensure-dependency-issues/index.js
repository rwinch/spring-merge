import * as core from "@actions/core";
import { call, createOctokit, parseRepository } from "../lib/octokit.js";
import { execute, isMain } from "../lib/run.js";

/**
 * The title of the issue of an update. It is not an input: the issue of an update is
 * found by its title, so every run must write the same one.
 */
export function issueTitle(dependency, version) {
  return `Update ${dependency} to ${version}`;
}

function issueBody(dependency, version) {
  return `Update the version of \`${dependency}\` to \`${version}\`, the version of the release train.`;
}

/** A list of labels, separated by commas or lines, without the empty ones. */
export function parseLabels(text) {
  return (text ?? "")
    .split(/[,\n]/)
    .map((label) => label.trim())
    .filter(Boolean);
}

/**
 * The updates as a list in the order of the names, from an object from the name to the
 * version, or to { version } (what map-train-versions and update-versions write).
 */
export function updatesOf(versions) {
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    throw new Error(
      "The versions must be an object from the name of a version to its new version",
    );
  }
  return Object.keys(versions)
    .sort()
    .map((dependency) => {
      const value = versions[dependency];
      const version = typeof value === "string" ? value : value?.version;
      if (!version || typeof version !== "string") {
        throw new Error(`The update of ${dependency} has no version`);
      }
      return { dependency, version };
    });
}

// The issues of a milestone, open and closed. A pull request is an issue too for GitHub,
// and is not what we are looking for.
async function listIssues(octokit, target, milestone, number) {
  const issues = await call(
    `Reading the issues of the milestone ${milestone} of ${target.owner}/${target.repo}`,
    octokit.paginate(octokit.rest.issues.listForRepo, {
      ...target,
      milestone: String(number),
      state: "all",
      per_page: 100,
    }),
  );
  return issues.filter((issue) => !issue.pull_request);
}

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Makes sure that every update has an issue in the milestone of a repository: the issue
 * that has its title in that milestone is the one of the update, open or closed, and
 * only if there is none, one is created. So a run that is done again does not make
 * another, and neither does an issue that someone closed: it is the decision to leave
 * the update, and it is for the caller to leave it (closed is in the result).
 *
 * It returns the updates with the number of their issue, and whether it existed, and
 * whether it is closed.
 *
 * GitHub lists a new issue a few seconds after it is created (2 to 5 seconds, measured).
 * A run that comes right after another one, after a cancelled run for example, would not
 * see its issues, and make them again. So after it has created issues, the action waits
 * until the list has them, up to attempts times intervalMs, and warns if it has not.
 */
export async function ensureIssues(
  { repository, milestone, versions, labels = [], type = "" },
  {
    octokit,
    log = () => {},
    warn = log,
    sleep = pause,
    intervalMs = 2000,
    attempts = 15,
  },
) {
  const updates = updatesOf(versions);
  const target = parseRepository(repository);
  if (!milestone) {
    throw new Error("The input milestone is required");
  }

  const milestones = await call(
    `Reading the milestones of ${repository}`,
    octokit.paginate(octokit.rest.issues.listMilestones, {
      ...target,
      state: "all",
      per_page: 100,
    }),
  );
  const found = milestones.find((m) => m.title === milestone);
  if (!found) {
    throw new Error(`${repository} has no milestone ${milestone}`);
  }

  const existing = await listIssues(octokit, target, milestone, found.number);

  const issues = {};
  const createdNumbers = [];
  for (const { dependency, version } of updates) {
    const title = issueTitle(dependency, version);
    // More than one with the same title is not meant to be: take an open one, and else
    // the first.
    const same = existing
      .filter((issue) => issue.title === title)
      .sort((a, b) => a.number - b.number);
    const issue = same.find((i) => i.state === "open") ?? same[0];
    if (issue) {
      issues[dependency] = {
        version,
        issue: issue.number,
        existed: true,
        closed: issue.state === "closed",
      };
      log(
        `${dependency} ${version}: issue ${issue.number} exists${issue.state === "closed" ? ", and is closed" : ""}`,
      );
      continue;
    }
    const { data: created } = await call(
      `Creating the issue "${title}" in ${repository}`,
      octokit.rest.issues.create({
        ...target,
        title,
        body: issueBody(dependency, version),
        milestone: found.number,
        ...(labels.length > 0 && { labels }),
        ...(type && { type }),
      }),
    );
    issues[dependency] = {
      version,
      issue: created.number,
      existed: false,
      closed: false,
    };
    createdNumbers.push(created.number);
    log(`${dependency} ${version}: issue ${created.number} created`);
  }

  if (createdNumbers.length > 0) {
    let listed = false;
    for (let attempt = 0; attempt < attempts && !listed; attempt++) {
      const numbers = new Set(
        (await listIssues(octokit, target, milestone, found.number)).map(
          (issue) => issue.number,
        ),
      );
      listed = createdNumbers.every((number) => numbers.has(number));
      if (!listed) {
        await sleep(intervalMs);
      }
    }
    if (!listed) {
      warn(
        `The issues ${createdNumbers.join(", ")} are not in the list of ${repository} after ${(attempts * intervalMs) / 1000} seconds: a run that comes right now may create them again`,
      );
    }
  }
  return issues;
}

export async function main() {
  let versions;
  try {
    versions = JSON.parse(core.getInput("versions", { required: true }));
  } catch (error) {
    throw new Error(`The input versions is not JSON: ${error.message}`);
  }
  const octokit = createOctokit({ token: core.getInput("token") });
  const issues = await ensureIssues(
    {
      repository: core.getInput("repository", { required: true }),
      milestone: core.getInput("milestone", { required: true }),
      versions,
      labels: parseLabels(core.getInput("labels")),
      type: core.getInput("type"),
    },
    {
      octokit,
      log: (line) => core.info(line),
      warn: (line) => core.warning(line),
    },
  );
  const all = Object.values(issues);
  core.info(
    `${all.length} issues: ${all.filter((i) => !i.existed).length} created, ${all.filter((i) => i.existed && !i.closed).length} open already, ${all.filter((i) => i.closed).length} closed`,
  );
  core.setOutput("issues", JSON.stringify(issues));
  core.setOutput("count", String(all.length));
}

if (isMain(import.meta.url)) {
  execute(main);
}
