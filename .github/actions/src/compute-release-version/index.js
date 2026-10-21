import * as core from "@actions/core";
import { parseBoolean } from "../lib/inputs.js";
import { call, createOctokit, parseRepository } from "../lib/octokit.js";
import { execute, isMain } from "../lib/run.js";

const SNAPSHOT = "-SNAPSHOT";

// The milestones of a repository ("owner/repo"), all pages. A milestone has a title, a
// state and due_on (an ISO timestamp in UTC, or null). The state is open, closed or all.
function listMilestones(octokit, repository, state) {
  const { owner, repo } = parseRepository(repository);
  return call(
    `Reading the milestones of ${repository} (${state})`,
    octokit.paginate(octokit.rest.issues.listMilestones, {
      owner,
      repo,
      state,
      per_page: 100,
    }),
  );
}

/**
 * The version a snapshot version is going to be released as, before looking at the
 * milestones: 7.0.1-SNAPSHOT gives 7.0.1. A snapshot version never carries a
 * milestone (M) or a release candidate (RC), so only numbers are accepted.
 */
export function candidateOf(snapshotVersion) {
  const version = (snapshotVersion ?? "").trim();
  if (!version.endsWith(SNAPSHOT)) {
    throw new Error(
      `"${version}" is not a snapshot version: it must end with ${SNAPSHOT}`,
    );
  }
  const candidate = version.slice(0, -SNAPSHOT.length);
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(candidate)) {
    throw new Error(
      `Cannot get a release version from "${version}": expected <major>.<minor>.<patch>[.<hotfix>]${SNAPSHOT}`,
    );
  }
  return candidate;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The order of the releases of a version: its milestones, then its release candidates,
// then the version itself.
function releaseOrder(title, candidate) {
  const match = title.slice(candidate.length).match(/^-(M|RC)(\d+)$/);
  if (!match) {
    return [2, 0];
  }
  return [match[1] === "M" ? 0 : 1, Number(match[2])];
}

function byDueDateThenRelease(candidate) {
  return (a, b) => {
    // A milestone without a due date comes last.
    const dueA = a.due_on ? Date.parse(a.due_on) : Infinity;
    const dueB = b.due_on ? Date.parse(b.due_on) : Infinity;
    if (dueA !== dueB) {
      return dueA < dueB ? -1 : 1;
    }
    const [kindA, numberA] = releaseOrder(a.title, candidate);
    const [kindB, numberB] = releaseOrder(b.title, candidate);
    return kindA - kindB || numberA - numberB;
  };
}

/**
 * Works out the version a snapshot version is released as, and when, from the
 * milestones of a repository:
 *
 * - 7.0.1-SNAPSHOT is released as 7.0.1.
 * - 7.1.0-SNAPSHOT is a .0 version: it is released as one of its milestones
 *   (7.1.0-M1, 7.1.0-RC1) or as 7.1.0 itself. The open milestone with the earliest
 *   due date of those is next.
 *
 * The due date is a date in UTC (a milestone is due at noon UTC, so it is the same
 * day in every time zone). It fails if the milestone does not exist, and if it has no
 * due date, unless requireDueDate is false.
 */
export async function run(
  { snapshotVersion, milestoneRepository, requireDueDate = true },
  { octokit },
) {
  const candidate = candidateOf(snapshotVersion);
  let milestone;
  if (candidate.endsWith(".0")) {
    const pattern = new RegExp(`^${escapeRegExp(candidate)}(-(M|RC)\\d+)?$`);
    const open = await listMilestones(octokit, milestoneRepository, "open");
    const matching = open
      .filter((m) => pattern.test(m.title))
      .sort(byDueDateThenRelease(candidate));
    if (matching.length === 0) {
      throw new Error(
        `${milestoneRepository} has no open milestone for ${candidate}: expected ${candidate}, ${candidate}-M<n> or ${candidate}-RC<n>`,
      );
    }
    milestone = matching[0];
  } else {
    const all = await listMilestones(octokit, milestoneRepository, "all");
    milestone = all.find((m) => m.title === candidate);
    if (!milestone) {
      throw new Error(`${milestoneRepository} has no milestone ${candidate}`);
    }
  }

  const dueDate = milestone.due_on
    ? new Date(milestone.due_on).toISOString().slice(0, 10)
    : "";
  if (!dueDate && requireDueDate) {
    throw new Error(
      `The milestone ${milestone.title} of ${milestoneRepository} has no due date (set require-due-date to false to allow that)`,
    );
  }
  return { releaseVersion: milestone.title, dueDate };
}

export async function main() {
  const inputs = {
    snapshotVersion: core.getInput("snapshot-version", { required: true }),
    milestoneRepository: core.getInput("milestone-repository", {
      required: true,
    }),
    requireDueDate: parseBoolean(
      "require-due-date",
      core.getInput("require-due-date"),
      true,
    ),
  };
  const octokit = createOctokit({ token: core.getInput("milestone-token") });
  const { releaseVersion, dueDate } = await run(inputs, { octokit });
  core.info(
    `${inputs.snapshotVersion} is released as ${releaseVersion}, due ${dueDate || "on no date"}`,
  );
  core.setOutput("release-version", releaseVersion);
  core.setOutput("due-date", dueDate);
}

if (isMain(import.meta.url)) {
  execute(main);
}
