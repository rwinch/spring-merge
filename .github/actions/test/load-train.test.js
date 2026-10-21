import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, writeFiles } from "../src/load-train/index.js";
import { createOctokit } from "../src/lib/octokit.js";
import { startFakeGitHub } from "./support/fake-github.js";
import { runAction } from "./support/run-action.js";

const REPO = "tutorial/release-train";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "load-train-"));

describe("run", () => {
  let fake;
  const octokit = (options = {}) =>
    createOctokit({ baseUrl: fake.url, ...options });
  const load = (branch, repository = REPO) =>
    run({ repository, branch }, { octokit: octokit() });

  beforeAll(async () => {
    fake = await startFakeGitHub();
  });
  afterAll(() => fake.close());

  it("reads release-versions.json and train.yml of a train", async () => {
    const train = await load("2026.11.19");
    expect(train.found).toBe(true);
    expect(train.releaseVersions["spring-framework"]).toEqual([
      "7.0.10",
      "7.0.10.1",
      "7.1.0-RC1",
    ]);
    expect(train.train.state).toBe("started");
    expect(train.train.schedule.operation.promote).toBe("2026-11-19");
  });

  it("gives access to every release of train.yml, with its version as a string", async () => {
    const { train } = await load("2026.11.19");
    const release = train.releases["spring-framework"]["7.0.10.1"];
    expect(release["commit-hashes"].joined).toMatch(/^[0-9a-f]{40}$/);
    expect(release["deployment-destination"]).toBe("spring_enterprise");
    // joined, but not ready
    expect(
      train.releases.reactor["2025.0.8"]["commit-hashes"].ready,
    ).toBeUndefined();
  });

  it("is no data for a train that has not been created", async () => {
    expect(await load("2030.01.01")).toEqual({
      found: false,
      releaseVersions: {},
      train: {},
    });
  });

  it("fails for a repository that cannot be read, and does not call it a missing train", async () => {
    await expect(load("2026.11.19", "missing/missing")).rejects.toThrow(
      /Reading missing\/missing failed with 404.*cannot read it/,
    );
  });

  it("fails for a branch without train.yml", async () => {
    await expect(load("main")).rejects.toThrow(
      "The branch main of tutorial/release-train has no train.yml",
    );
  });

  it("fails if the branch is not given or the repository is not owner/repo", async () => {
    await expect(load("")).rejects.toThrow("branch is required");
    await expect(load("2026.11.19", "nonsense")).rejects.toThrow(
      "expected owner/repo",
    );
  });

  it("sends the token", async () => {
    fake.requests.length = 0;
    await run(
      { repository: REPO, branch: "2026.11.19" },
      { octokit: octokit({ token: "the-token" }) },
    );
    expect(
      fake.requests.every((r) => r.headers.authorization === "token the-token"),
    ).toBe(true);
    expect(fake.requests.length).toBeGreaterThan(2);
  });

  describe("a train that is damaged", () => {
    const damaged = async (versions, train) => {
      const trains = tmp();
      fs.mkdirSync(path.join(trains, "2030.02.02"));
      fs.writeFileSync(
        path.join(trains, "2030.02.02", "release-versions.json"),
        versions,
      );
      fs.writeFileSync(path.join(trains, "2030.02.02", "train.yml"), train);
      const other = await startFakeGitHub({ trains });
      try {
        return await run(
          { repository: REPO, branch: "2030.02.02" },
          { octokit: createOctokit({ baseUrl: other.url }) },
        );
      } finally {
        await other.close();
      }
    };

    it("fails if release-versions.json is not JSON", async () => {
      await expect(damaged("{ not json", "state: started\n")).rejects.toThrow(
        /release-versions.json of 2030.02.02 of tutorial\/release-train is not JSON/,
      );
    });

    it("fails if train.yml is not YAML", async () => {
      await expect(damaged("{}", "state: [unclosed\n")).rejects.toThrow(
        /train.yml of 2030.02.02 of tutorial\/release-train is not YAML/,
      );
    });

    it("reads an empty train.yml as no releases", async () => {
      const result = await damaged("{}", "");
      expect(result).toEqual({ found: true, releaseVersions: {}, train: {} });
    });
  });
});

describe("writeFiles", () => {
  it("writes the two files as JSON", () => {
    const directory = path.join(tmp(), "nested");
    const { releaseVersionsFile, trainFile } = writeFiles(directory, {
      releaseVersions: { a: ["1.0.0"] },
      train: { state: "started" },
    });
    expect(JSON.parse(fs.readFileSync(releaseVersionsFile, "utf8"))).toEqual({
      a: ["1.0.0"],
    });
    expect(JSON.parse(fs.readFileSync(trainFile, "utf8"))).toEqual({
      state: "started",
    });
  });
});

// The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
describe.each([["src/load-train/index.js"], ["dist/load-train/index.js"]])(
  "the program %s",
  (entry) => {
    let fake;
    beforeAll(async () => {
      fake = await startFakeGitHub();
    });
    afterAll(() => fake.close());

    const inputs = (branch, more = {}) => ({
      "release-train-repository": REPO,
      branch,
      ...more,
    });

    it("writes its outputs and the files", async () => {
      const directory = tmp();
      const result = await runAction(
        entry,
        inputs("2026.11.19", { "output-directory": directory }),
        { GITHUB_API_URL: fake.url },
      );
      expect(result.code).toBe(0);
      expect(result.outputs.found).toBe("true");
      const versions = JSON.parse(result.outputs["release-versions"]);
      expect(versions.micrometer).toEqual(["1.16.8", "1.17.2"]);
      expect(JSON.parse(result.outputs.train).state).toBe("started");
      expect(result.outputs["release-versions-file"]).toBe(
        path.join(directory, "release-versions.json"),
      );
      expect(
        JSON.parse(fs.readFileSync(result.outputs["train-file"], "utf8"))
          .releases.micrometer["1.16.8"]["commit-hashes"].joined,
      ).toMatch(/^[0-9a-f]{40}$/);
    });

    it("succeeds with no data for a train that has not been created", async () => {
      const result = await runAction(entry, inputs("2030.01.01"), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(0);
      expect(result.outputs.found).toBe("false");
      expect(result.outputs["release-versions"]).toBe("{}");
      expect(result.outputs.train).toBe("{}");
      expect(result.stdout).toContain("has not been created");
      expect(fs.existsSync(result.outputs["train-file"])).toBe(true);
    });

    it("uses spring-io/release-train when no repository is given", async () => {
      fake.requests.length = 0;
      await runAction(
        entry,
        { branch: "2026.11.19" },
        {
          GITHUB_API_URL: fake.url,
        },
      );
      expect(fake.requests[0].path).toBe("/repos/spring-io/release-train");
    });

    it("fails with an error that GitHub shows", async () => {
      const result = await runAction(
        entry,
        inputs("2026.11.19", { "release-train-repository": "missing/missing" }),
        { GITHUB_API_URL: fake.url },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "::error::Reading missing/missing failed with 404",
      );
    });
  },
);
