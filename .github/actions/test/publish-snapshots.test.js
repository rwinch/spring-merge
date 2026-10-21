import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createWorld, workflowsDir } from "./support/world.js";

// publish-snapshots.yml, as the push of a snapshot branch runs it: the jar is built with
// the Gradle wrapper of the project, and what would be published is logged. It needs Java
// and a Gradle distribution (the one of the wrapper, which is downloaded if the
// developer has not got it). SKIP_BUILD=1 skips the tests that build.

const build = process.env.SKIP_BUILD ? it.skip : it;
const read = (name) =>
  parse(fs.readFileSync(path.join(workflowsDir, name), "utf8"));

// A branch pattern of a workflow: * is anything but a slash, ** is anything
const matches = (pattern, branch) =>
  new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*")}$`,
  ).test(branch);
const triggeredBy = (name, branch) =>
  read(name).on.push.branches.some((pattern) => matches(pattern, branch));

describe("publish-snapshots", () => {
  let world;
  afterEach(() => world?.close());
  const publish = () => world.run({ workflow: "publish-snapshots.yml" });

  build(
    "builds the jar of an internal snapshot, and logs what it would publish",
    async () => {
      world = await createWorld({
        branch: "disclosure/7.0.1-INTERNAL-SNAPSHOT",
        version: "7.0.1-INTERNAL-SNAPSHOT",
      });
      const result = await publish();

      expect(result.ok).toBe(true);
      expect(result.step("Build the jar").outcome).toBe("success");
      const published = result.step("Publish (pretended)");
      expect(published.outcome).toBe("success");
      expect(published.output).toMatch(
        /Would publish build\/libs\/[^ ]+-7\.0\.1-INTERNAL-SNAPSHOT\.jar as the snapshot 7\.0\.1-INTERNAL-SNAPSHOT \(\d+ bytes, sha256 [0-9a-f]{64}\)/,
      );
      const jar = fs
        .readdirSync(path.join(result.jobs.publish.workspace, "build", "libs"))
        .find((file) => file.endsWith(".jar"));
      expect(jar).toContain("7.0.1-INTERNAL-SNAPSHOT");
      expect(result.jobs.publish.summary).toContain(
        "Would publish the snapshot 7.0.1-INTERNAL-SNAPSHOT",
      );
      expect(result.jobs.publish.summary).toContain(jar);
    },
  );

  build("builds the snapshot of a hotfix", async () => {
    world = await createWorld({
      branch: "disclosure/7.0.1.1-SNAPSHOT",
      version: "7.0.1.1-SNAPSHOT",
    });
    const result = await publish();
    expect(result.ok).toBe(true);
    expect(result.step("Publish (pretended)").output).toContain(
      "as the snapshot 7.0.1.1-SNAPSHOT",
    );
  });

  it("publishes nothing for a branch that does not have a snapshot version, and builds nothing", async () => {
    world = await createWorld({
      branch: "disclosure/7.0.1-SNAPSHOT",
      version: "7.0.1",
    });
    const result = await publish();
    expect(result.ok).toBe(false);
    expect(result.step("Check that it is a snapshot").output).toContain(
      "::error title=Not a snapshot::disclosure/7.0.1-SNAPSHOT has the version 7.0.1",
    );
    expect(result.step("Build the jar").outcome).toBe("skipped");
    expect(result.step("Publish (pretended)").outcome).toBe("skipped");
  });

  describe("what runs for a push", () => {
    it.each([
      "disclosure/7.0.1-INTERNAL-SNAPSHOT",
      "disclosure/7.1.0-INTERNAL-SNAPSHOT",
      "disclosure/7.0.1.1-SNAPSHOT",
    ])(
      "the snapshot branch %s publishes, and does not build the release branches again",
      (branch) => {
        expect(triggeredBy("publish-snapshots.yml", branch)).toBe(true);
        expect(triggeredBy("release-branches.yml", branch)).toBe(false);
      },
    );

    it.each([
      "disclosure/frozen/7.0.x",
      "disclosure/frozen/main",
      "disclosure/active/7.0.x",
    ])(
      "the disclosure branch %s builds the release branches, and publishes nothing",
      (branch) => {
        expect(triggeredBy("release-branches.yml", branch)).toBe(true);
        expect(triggeredBy("publish-snapshots.yml", branch)).toBe(false);
      },
    );

    it.each(["release/7.0.1", "release/7.0.1.1", "main", "7.0.x", "feature/x"])(
      "%s runs neither",
      (branch) => {
        expect(triggeredBy("release-branches.yml", branch)).toBe(false);
        expect(triggeredBy("publish-snapshots.yml", branch)).toBe(false);
      },
    );

    it("has a pattern that is the one that GitHub reads", () => {
      expect(matches("disclosure/*-SNAPSHOT", "disclosure/a/b-SNAPSHOT")).toBe(
        false,
      );
      expect(matches("disclosure/frozen/**", "disclosure/frozen/a/b")).toBe(
        true,
      );
    });
  });
});
