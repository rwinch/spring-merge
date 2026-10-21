import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "./git-repo.js";
import { startFakeGitHub } from "./fake-github.js";
import { actionsDir } from "./run-action.js";
import { runWorkflow } from "./run-workflow.js";

// The project: the directory that has .github (the actions are in .github/actions)
export const projectRoot = path.resolve(actionsDir, "..", "..");
export const workflowsDir = path.join(projectRoot, ".github", "workflows");
export const workflowFile = path.join(workflowsDir, "release-branches.yml");

const SKIP = new Set(["node_modules", ".git", ".gradle", "build"]);

/**
 * A world for the release workflow, with no GitHub:
 *
 *  - the commercial repository, as a bare repository, with the disclosure branch that was
 *    pushed, a copy of the project with the version that is given
 *  - the fake GitHub, which has the milestones, the issues and the release train that
 *    the test gives it (or those of the fixtures)
 *
 * `run()` runs the workflow as the push of that branch would, in a fresh checkout for every
 * job, as GitHub does. The result and the repository are there to look at.
 */
export async function createWorld({
  branch = "disclosure/frozen/7.0.x",
  version = "7.0.1-SNAPSHOT",
  catalog,
  extraBranches = {},
  fake: fakeOptions = {},
  vars = { RELEASE_TRAIN_REPOSITORY: "tutorial/release-train" },
  secrets = {
    RELEASE_AUTOMATION_TOKEN: "automation-token",
    GITHUB_TOKEN: "github-token",
  },
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "world-"));
  const remote = path.join(base, "commercial.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);

  // The pushed commit: the project, as the template has it, with the version of the test.
  const seed = path.join(base, "seed");
  fs.cpSync(projectRoot, seed, {
    recursive: true,
    filter: (source) => !SKIP.has(path.basename(source)),
  });
  fs.writeFileSync(
    path.join(seed, "gradle.properties"),
    `version=${version}\n`,
  );
  if (catalog) {
    fs.writeFileSync(path.join(seed, "gradle", "libs.versions.toml"), catalog);
  }
  git(seed, "init", "-q", "-b", branch);
  git(seed, "add", "-A");
  git(
    seed,
    "-c",
    "user.name=Alice",
    "-c",
    "user.email=alice@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "A commit of the disclosure",
  );
  git(seed, "push", "-q", remote, `HEAD:refs/heads/${branch}`);
  const tip = git(seed, "rev-parse", "HEAD");
  for (const [name, content] of Object.entries(extraBranches)) {
    // a branch that is there already, like the release branch of an earlier run
    git(seed, "switch", "-q", "-c", name);
    fs.writeFileSync(path.join(seed, "from-an-earlier-run.txt"), content);
    git(seed, "add", "-A");
    git(
      seed,
      "-c",
      "user.name=Earlier",
      "-c",
      "user.email=earlier@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "A commit that an earlier run made",
    );
    git(seed, "push", "-q", remote, `HEAD:refs/heads/${name}`);
    git(seed, "switch", "-q", branch);
  }

  const fake = await startFakeGitHub(fakeOptions);
  let checkouts = 0;

  const world = {
    base,
    remote,
    tip,
    branch,
    fake,
    /** Git in the bare repository. */
    git: (...args) => git(remote, ...args),
    /** A file of a branch of the repository, as text. */
    file: (ref, file) => git(remote, "show", `${ref}:${file}`),
    branches: () =>
      git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads")
        .split("\n")
        .filter(Boolean)
        .sort(),
    /** The subjects of the commits of a branch after the pushed commit, oldest first. */
    subjects: (ref) =>
      git(remote, "log", "--reverse", "--format=%s", `${tip}..${ref}`)
        .split("\n")
        .filter(Boolean),
    /** The versions of the [versions] section of the catalog of a branch. */
    versions: (ref) =>
      Object.fromEntries(
        [
          ...world
            .file(ref, "gradle/libs.versions.toml")
            .matchAll(/^([a-z-]+) = "([^"]+)"$/gm),
        ].map((match) => [match[1], match[2]]),
      ),
    version: (ref) =>
      world
        .file(ref, "gradle.properties")
        .replace(/^version=/, "")
        .trim(),
    async run({ workflow = "release-branches.yml" } = {}) {
      return runWorkflow({
        workflowFile: path.join(workflowsDir, workflow),
        github: {
          ref: `refs/heads/${branch}`,
          ref_name: branch,
          sha: tip,
          repository: "tutorial/spring-merge-commercial",
          repository_owner: "tutorial",
          event_name: "push",
        },
        secrets,
        vars,
        env: {
          GITHUB_API_URL: fake.url,
          // the Gradle of the developer, so the distribution is not downloaded for every run
          GRADLE_USER_HOME:
            process.env.GRADLE_USER_HOME ?? path.join(os.homedir(), ".gradle"),
        },
        // a fresh checkout of the pushed commit for every job, with the repository as origin
        checkout: async () => {
          const directory = path.join(base, `checkout-${checkouts++}`);
          execFileSync("git", ["clone", "-q", remote, directory], {
            stdio: "pipe",
          });
          git(directory, "checkout", "-q", "--detach", tip);
          return directory;
        },
      });
    },
    close: () => fake.close(),
  };
  return world;
}
