import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMilestones } from "./support/fake-github.js";
import { createWorld } from "./support/world.js";

// The release workflow, release-branches.yml, as the push of a disclosure branch runs it:
// every job in a fresh checkout, the real actions and scripts of the project, a bare
// repository for the commercial repository, and a fake GitHub with the milestones, the
// issues and the release train of the tests (test/fixtures). Nothing of GitHub is used.

const milestones = JSON.parse(fs.readFileSync(defaultMilestones, "utf8"));
const JAVA = "src/main/java/org/springframework/example/Greeter.java";
const names = [
  "micrometer",
  "reactor",
  "spring-data-bom",
  "spring-framework",
  "spring-ldap",
];
const updates = (versions) =>
  names.map((name) => `Update ${name} to ${versions[name]}`);

// What the template has, and what the practice train of 2026-11-19 asks for (see its README)
const TEMPLATE = {
  micrometer: "1.16.7",
  reactor: "2025.0.7",
  "spring-data-bom": "2025.1.7",
  "spring-framework": "7.0.9",
  "spring-ldap": "4.0.5",
};
const RELEASE = {
  micrometer: "1.16.8",
  reactor: "2025.0.8",
  "spring-data-bom": "2025.1.8",
  "spring-framework": "7.0.10",
  "spring-ldap": "4.0.6",
};
const HOTFIX_RELEASE = {
  ...RELEASE,
  "spring-data-bom": "2025.1.8.1",
  "spring-framework": "7.0.10.1",
  "spring-ldap": "4.0.6.1",
};
const INTERNAL = Object.fromEntries(
  Object.entries(RELEASE).map(([name, version]) => [
    name,
    `${version}-INTERNAL-SNAPSHOT`,
  ]),
);
const HOTFIX_SNAPSHOT = {
  micrometer: "1.16.8-INTERNAL-SNAPSHOT", // the train has no hotfix of it
  reactor: "2025.0.8-INTERNAL-SNAPSHOT",
  "spring-data-bom": "2025.1.8.1-SNAPSHOT",
  "spring-framework": "7.0.10.1-SNAPSHOT",
  "spring-ldap": "4.0.6.1-SNAPSHOT",
};

describe("the release workflow", () => {
  let world;
  afterEach(() => world?.close());

  const failedStep = (result) =>
    Object.values(result.jobs)
      .flatMap((job) => job.steps)
      .find((step) => step.outcome === "failure");
  const authors = (ref) =>
    world
      .git("log", "--format=%an <%ae>", `${world.tip}..${ref}`)
      .split("\n")
      .filter(Boolean);
  const closes = (ref) =>
    world
      .git("log", "--reverse", "--format=%b", `${world.tip}..${ref}`)
      .split("\n")
      .filter((line) => line.startsWith("Closes gh-"));

  describe("a frozen disclosure", () => {
    it("builds the release and an internal snapshot of the version", async () => {
      world = await createWorld({
        branch: "disclosure/frozen/7.0.x",
        version: "7.0.1-SNAPSHOT",
      });
      const result = await world.run();

      expect(failedStep(result)).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(world.branches()).toEqual([
        "disclosure/7.0.1-INTERNAL-SNAPSHOT",
        "disclosure/frozen/7.0.x",
        "release/7.0.1",
      ]);

      // the release: one commit for each dependency, with its issue, and then the version
      expect(world.subjects("release/7.0.1")).toEqual([
        ...updates(RELEASE),
        "Release 7.0.1",
      ]);
      expect(world.versions("release/7.0.1")).toEqual(RELEASE);
      expect(world.version("release/7.0.1")).toBe("7.0.1");
      expect(closes("release/7.0.1")).toEqual(
        [1, 2, 3, 4, 5].map((n) => `Closes gh-${n}`),
      );

      // the snapshot: the version, and a snapshot of every dependency that has joined, with no issue
      expect(world.subjects("disclosure/7.0.1-INTERNAL-SNAPSHOT")).toEqual([
        "Set the version to 7.0.1-INTERNAL-SNAPSHOT",
        ...updates(INTERNAL),
      ]);
      expect(world.versions("disclosure/7.0.1-INTERNAL-SNAPSHOT")).toEqual(
        INTERNAL,
      );
      expect(world.version("disclosure/7.0.1-INTERNAL-SNAPSHOT")).toBe(
        "7.0.1-INTERNAL-SNAPSHOT",
      );
      expect(closes("disclosure/7.0.1-INTERNAL-SNAPSHOT")).toEqual([]);
    });

    it("builds both from the pushed commit, and neither has the commercial license", async () => {
      world = await createWorld();
      await world.run();
      for (const ref of [
        "release/7.0.1",
        "disclosure/7.0.1-INTERNAL-SNAPSHOT",
      ]) {
        expect(world.git("merge-base", world.tip, ref)).toBe(world.tip);
        expect(world.file(ref, "LICENSE.txt")).toContain("Apache License");
        expect(world.file(ref, JAVA)).toContain(
          "Licensed under the Apache License",
        );
        expect(world.file(ref, JAVA)).not.toContain("Broadcom");
      }
      // not one on the other: git says no (exit code 1) when it is not an ancestor
      expect(() =>
        world.git(
          "merge-base",
          "--is-ancestor",
          "disclosure/7.0.1-INTERNAL-SNAPSHOT",
          "release/7.0.1",
        ),
      ).toThrow();
    }, 120000);

    it("makes the commits as the bot, signed off", async () => {
      world = await createWorld();
      await world.run();
      for (const ref of [
        "release/7.0.1",
        "disclosure/7.0.1-INTERNAL-SNAPSHOT",
      ]) {
        const bot =
          "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
        expect(new Set(authors(ref))).toEqual(new Set([bot]));
        const bodies = world.git(
          "log",
          "--format=%b%x00",
          `${world.tip}..${ref}`,
        );
        for (const body of bodies.split("\0").filter((b) => b.trim())) {
          expect(body).toContain(`Signed-off-by: ${bot}`);
        }
      }
    });

    it("makes an issue for each dependency, in the milestone of the release", async () => {
      world = await createWorld();
      await world.run();
      expect(world.fake.issues.map((issue) => issue.title)).toEqual(
        updates(RELEASE),
      );
      for (const issue of world.fake.issues) {
        expect(issue.milestone).toMatchObject({ number: 3, title: "7.0.1" });
        expect(issue.labels).toEqual([{ name: "type: dependency-upgrade" }]);
        expect(issue.state).toBe("open");
      }
    });

    it("goes by the milestone for a .0 version: the release candidate", async () => {
      world = await createWorld({
        branch: "disclosure/frozen/main",
        version: "7.1.0-SNAPSHOT",
      });
      const result = await world.run();
      expect(failedStep(result)).toBeUndefined();
      expect(world.branches()).toEqual([
        "disclosure/7.1.0-INTERNAL-SNAPSHOT",
        "disclosure/frozen/main",
        "release/7.1.0-RC1",
      ]);
      // the internal snapshot has no milestone or release candidate, the release has
      expect(world.version("release/7.1.0-RC1")).toBe("7.1.0-RC1");
      expect(world.version("disclosure/7.1.0-INTERNAL-SNAPSHOT")).toBe(
        "7.1.0-INTERNAL-SNAPSHOT",
      );
      expect(world.subjects("release/7.1.0-RC1").at(-1)).toBe(
        "Release 7.1.0-RC1",
      );
      expect(world.fake.issues[0].milestone).toMatchObject({
        title: "7.1.0-RC1",
      });
    });

    it("summarizes what it built", async () => {
      world = await createWorld();
      const result = await world.run();
      expect(result.jobs.build.summary).toContain("release/7.0.1");
      expect(result.jobs.build.summary).toContain(
        "disclosure/7.0.1-INTERNAL-SNAPSHOT",
      );
    });
  });

  describe("an active disclosure, a hotfix", () => {
    const branch = "disclosure/active/7.0.x";

    it("builds the snapshot of the hotfix, and the release from it", async () => {
      world = await createWorld({ branch, version: "7.0.1-SNAPSHOT" });
      const result = await world.run();

      expect(failedStep(result)).toBeUndefined();
      expect(world.branches()).toEqual([
        "disclosure/7.0.1.1-SNAPSHOT",
        "disclosure/active/7.0.x",
        "release/7.0.1.1",
      ]);

      // no internal snapshot of a hotfix. The commercial license first, then the version, then
      // snapshots of the dependencies: a hotfix of it if the train has one, else the internal snapshot
      expect(world.subjects("disclosure/7.0.1.1-SNAPSHOT")).toEqual([
        "Commercial changes for 7.0.1.1",
        "Set the version to 7.0.1.1-SNAPSHOT",
        ...updates(HOTFIX_SNAPSHOT),
      ]);
      expect(world.versions("disclosure/7.0.1.1-SNAPSHOT")).toEqual(
        HOTFIX_SNAPSHOT,
      );
      expect(world.version("disclosure/7.0.1.1-SNAPSHOT")).toBe(
        "7.0.1.1-SNAPSHOT",
      );

      // the release is built on the snapshot, and goes from its snapshots to the versions
      expect(
        world.git(
          "merge-base",
          "--is-ancestor",
          "disclosure/7.0.1.1-SNAPSHOT",
          "release/7.0.1.1",
        ),
      ).toBe("");
      const snapshotCommits = world.subjects(
        "disclosure/7.0.1.1-SNAPSHOT",
      ).length;
      expect(world.subjects("release/7.0.1.1").slice(snapshotCommits)).toEqual([
        ...updates(HOTFIX_RELEASE),
        "Release 7.0.1.1",
      ]);
      expect(world.versions("release/7.0.1.1")).toEqual(HOTFIX_RELEASE);
      expect(world.version("release/7.0.1.1")).toBe("7.0.1.1");
    });

    it("has the commercial license and the Broadcom headers, on both", async () => {
      world = await createWorld({ branch });
      await world.run();
      for (const ref of ["disclosure/7.0.1.1-SNAPSHOT", "release/7.0.1.1"]) {
        expect(world.file(ref, "LICENSE.txt")).toContain(
          "Foundation Agreement",
        );
        expect(world.file(ref, "LICENSE.txt")).not.toContain("Apache License");
        expect(world.file(ref, JAVA)).toContain(
          "Copyright 2004 Broadcom Inc. and/or its subsidiaries",
        );
        expect(world.file(ref, JAVA)).not.toContain(
          "Licensed under the Apache License",
        );
      }
      // and the disclosure branch itself is not changed
      expect(world.file("disclosure/active/7.0.x", "LICENSE.txt")).toContain(
        "Apache License",
      );
    });

    it("makes the issues of the hotfix, in the milestone of the hotfix", async () => {
      world = await createWorld({ branch });
      await world.run();
      expect(world.fake.issues.map((issue) => issue.title)).toEqual(
        updates(HOTFIX_RELEASE),
      );
      expect(
        world.fake.issues.every((issue) => issue.milestone.title === "7.0.1.1"),
      ).toBe(true);
      // the commits of the snapshot have none: only the release closes issues
      expect(closes("disclosure/7.0.1.1-SNAPSHOT")).toEqual([]);
      expect(closes("release/7.0.1.1")).toHaveLength(5);
    });

    it("builds nothing for a version that is not a patch release", async () => {
      world = await createWorld({
        branch: "disclosure/active/main",
        version: "7.1.0-SNAPSHOT",
      });
      const result = await world.run();
      expect(result.ok).toBe(true);
      expect(result.jobs.plan.outputs.release).toBe("false");
      expect(result.jobs.build.result).toBe("skipped");
      expect(world.branches()).toEqual(["disclosure/active/main"]);
      expect(world.fake.issues).toEqual([]);
    });
  });

  describe("the release train", () => {
    it("builds the branches without the dependencies if there is no train", async () => {
      // the milestone 7.0.3 is due on 2027-02-11, and no train has been made for that day
      world = await createWorld({ version: "7.0.3-SNAPSHOT" });
      const result = await world.run();
      expect(result.ok).toBe(true);
      expect(result.step("There is no release train").outcome).toBe("success");
      expect(result.step("There is no release train").output).toContain(
        "has not been created",
      );
      expect(world.subjects("release/7.0.3")).toEqual(["Release 7.0.3"]);
      expect(world.subjects("disclosure/7.0.3-INTERNAL-SNAPSHOT")).toEqual([
        "Set the version to 7.0.3-INTERNAL-SNAPSHOT",
      ]);
      expect(world.versions("release/7.0.3")).toEqual(TEMPLATE);
      expect(world.fake.issues).toEqual([]);
    });

    it("leaves a dependency that has not joined the train", async () => {
      // the train of 2027-01-14 has no spring-ldap
      world = await createWorld({ version: "7.0.2-SNAPSHOT" });
      const result = await world.run();
      expect(result.ok).toBe(true);
      const { "spring-ldap": _, ...others } = RELEASE;
      expect(world.versions("release/7.0.2")).toEqual({
        ...others,
        "spring-ldap": "4.0.5",
      });
      expect(world.versions("disclosure/7.0.2-INTERNAL-SNAPSHOT")).toEqual({
        ...Object.fromEntries(
          Object.entries(INTERNAL).filter(([name]) => name !== "spring-ldap"),
        ),
        "spring-ldap": "4.0.5",
      });
      expect(world.fake.issues).toHaveLength(4);
      expect(
        world.fake.issues.some((issue) => issue.title.includes("spring-ldap")),
      ).toBe(false);
    });

    it("updates a dependency that has joined, and is not ready", async () => {
      // reactor 2025.0.8 has joined and is not ready: it is updated, on both branches
      world = await createWorld();
      await world.run();
      expect(world.versions("release/7.0.1").reactor).toBe("2025.0.8");
      expect(world.versions("disclosure/7.0.1-INTERNAL-SNAPSHOT").reactor).toBe(
        "2025.0.8-INTERNAL-SNAPSHOT",
      );
    });

    it("uses the release train repository that it is given, or the default one", async () => {
      world = await createWorld({ vars: {} });
      const result = await world.run();
      // the default repository is not the one of the fake, but the fake serves any repository
      expect(result.ok).toBe(true);
      expect(
        world.fake.requests.some((r) =>
          r.path.startsWith("/repos/spring-io/release-train"),
        ),
      ).toBe(true);
      world.close();
      world = await createWorld({
        vars: { RELEASE_TRAIN_REPOSITORY: "somebody/trains" },
      });
      await world.run();
      expect(
        world.fake.requests.some((r) =>
          r.path.startsWith("/repos/somebody/trains/"),
        ),
      ).toBe(true);
    });

    it("does not change a release that is ready: it stops, and says what to do", async () => {
      // 7.1.0 is due on 2026-12-17, and its train has the project 7.1.0 ready.
      // Its release candidate is done, so the milestone is the one of 7.1.0.
      const afterRc = milestones.map((m) =>
        m.title === "7.1.0-RC1" ? { ...m, state: "closed" } : m,
      );
      world = await createWorld({
        branch: "disclosure/frozen/main",
        version: "7.1.0-SNAPSHOT",
        fake: { milestones: afterRc },
      });
      const result = await world.run();

      expect(result.ok).toBe(false);
      const step = failedStep(result);
      expect(step.name).toBe("Stop if the release is ready already");
      expect(step.output).toContain(
        "::error title=spring-merge 7.1.0 is ready::",
      );
      expect(step.output).toContain("is ready in the release train 2026.12.17");
      expect(step.output).toContain(
        "set the version of gradle.properties to the next version in the OSS repository, and merge forward",
      );
      // nothing was done: no issue, no branch
      expect(world.fake.issues).toEqual([]);
      expect(world.branches()).toEqual(["disclosure/frozen/main"]);
    });
  });

  describe("an issue that was closed", () => {
    const closed = {
      number: 40,
      title: "Update spring-framework to 7.0.10",
      state: "closed",
      milestone: { number: 3 },
    };

    it("leaves its update on the release, and says so", async () => {
      world = await createWorld({ fake: { issues: [closed] } });
      const result = await world.run();
      expect(result.ok).toBe(true);
      expect(world.subjects("release/7.0.1")).toEqual([
        ...updates(RELEASE).filter(
          (subject) => !subject.includes("spring-framework"),
        ),
        "Release 7.0.1",
      ]);
      expect(world.versions("release/7.0.1")["spring-framework"]).toBe("7.0.9");
      expect(
        result.step("Leave the updates of closed issues").output,
      ).toContain(
        "spring-framework 7.0.10 is left alone: its issue #40 is closed",
      );
      // it is not made again, and the other four are
      expect(
        world.fake.issues.filter((issue) =>
          issue.title.includes("spring-framework"),
        ),
      ).toHaveLength(1);
      expect(world.fake.issues).toHaveLength(5);
    });

    it("does not change the snapshot, which has no issues", async () => {
      world = await createWorld({ fake: { issues: [closed] } });
      await world.run();
      expect(
        world.versions("disclosure/7.0.1-INTERNAL-SNAPSHOT")[
          "spring-framework"
        ],
      ).toBe("7.0.10-INTERNAL-SNAPSHOT");
    });
  });

  describe("again", () => {
    it("builds the same, without making the issues again", async () => {
      world = await createWorld();
      await world.run();
      const trees = ["release/7.0.1", "disclosure/7.0.1-INTERNAL-SNAPSHOT"].map(
        (ref) => world.git("rev-parse", `${ref}^{tree}`),
      );
      const result = await world.run();
      expect(result.ok).toBe(true);
      expect(
        ["release/7.0.1", "disclosure/7.0.1-INTERNAL-SNAPSHOT"].map((ref) =>
          world.git("rev-parse", `${ref}^{tree}`),
        ),
      ).toEqual(trees);
      expect(world.fake.issues).toHaveLength(5);
    });

    it("builds them again from the pushed commit, whatever the branches had", async () => {
      world = await createWorld({
        extraBranches: {
          "release/7.0.1": "stale",
          "disclosure/7.0.1-INTERNAL-SNAPSHOT": "stale",
        },
      });
      expect(world.branches()).toContain("release/7.0.1");
      const result = await world.run();
      expect(result.ok).toBe(true);
      for (const ref of [
        "release/7.0.1",
        "disclosure/7.0.1-INTERNAL-SNAPSHOT",
      ]) {
        expect(() => world.file(ref, "from-an-earlier-run.txt")).toThrow();
        expect(world.git("merge-base", world.tip, ref)).toBe(world.tip);
        expect(
          world.git("log", "--format=%an", `${world.tip}..${ref}`),
        ).not.toContain("Earlier");
      }
      expect(world.subjects("release/7.0.1")).toEqual([
        ...updates(RELEASE),
        "Release 7.0.1",
      ]);
    });
  });

  describe("what goes wrong, and leaves nothing", () => {
    it("fails for a version that has no milestone", async () => {
      world = await createWorld({ version: "9.9.9-SNAPSHOT" });
      const result = await world.run();
      expect(result.ok).toBe(false);
      expect(failedStep(result).name).toBe("Work out the release version");
      expect(failedStep(result).output).toContain("has no milestone 9.9.9");
      expect(world.branches()).toEqual(["disclosure/frozen/7.0.x"]);
      expect(world.fake.issues).toEqual([]);
    });

    it("fails for a milestone that has no due date", async () => {
      world = await createWorld({
        branch: "disclosure/frozen/main",
        version: "7.2.0-SNAPSHOT",
      });
      const result = await world.run();
      expect(failedStep(result).output).toContain("has no due date");
      expect(world.branches()).toEqual(["disclosure/frozen/main"]);
    });

    it("pushes neither branch if the issues cannot be made", async () => {
      world = await createWorld();
      world.fake.createFailure = {
        status: 403,
        message: "Resource not accessible by personal access token",
      };
      const result = await world.run();
      expect(result.ok).toBe(false);
      const step = failedStep(result);
      expect(step.name).toBe("Make sure that there are issues");
      expect(step.output).toContain("check its permissions");
      // the snapshot was built before, and it was not pushed: both or none
      expect(world.branches()).toEqual(["disclosure/frozen/7.0.x"]);
      expect(result.step("Push the branches")).toMatchObject({
        outcome: "skipped",
      });
    });

    it("fails the plan for a version that cannot be planned, and builds nothing", async () => {
      world = await createWorld({
        branch: "disclosure/frozen/7.0.x",
        version: "7.0.1.1-SNAPSHOT",
      });
      const result = await world.run();
      expect(result.ok).toBe(false);
      expect(failedStep(result).name).toBe("Decide what to build");
      expect(result.jobs.build.result).toBe("skipped");
      expect(world.branches()).toEqual(["disclosure/frozen/7.0.x"]);
    });

    it("fails if the train repository cannot be read, and does not take it for no train", async () => {
      world = await createWorld({
        vars: { RELEASE_TRAIN_REPOSITORY: "missing/missing" },
      });
      const result = await world.run();
      expect(result.ok).toBe(false);
      expect(failedStep(result).name).toBe("Read the release train");
      expect(failedStep(result).output).toContain("cannot read it");
      expect(world.branches()).toEqual(["disclosure/frozen/7.0.x"]);
    });
  });

  describe("the workflow file", () => {
    const text = fs.readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "workflows",
        "release-branches.yml",
      ),
      "utf8",
    );

    it("runs for the disclosure branches only, one run at a time for a branch, newest first", () => {
      expect(text).toMatch(
        /branches:\n\s+- "disclosure\/frozen\/\*\*"\n\s+- "disclosure\/active\/\*\*"/,
      );
      expect(text).toContain("group: release-branches-${{ github.ref }}");
      expect(text).toContain("cancel-in-progress: true");
    });

    it("has no guard on the repository: the disclosure branches only exist in the commercial one", () => {
      expect(text).not.toMatch(/github\.repository ==/);
      expect(text).not.toMatch(/repository_owner ==/);
    });

    it("pins what it uses from outside, by commit", () => {
      const uses = [...text.matchAll(/uses: ([^\s]+)/g)]
        .map((m) => m[1])
        .filter((u) => !u.startsWith("./"));
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) {
        expect(use).toMatch(/@[0-9a-f]{40}$/);
      }
    });

    it("pushes once, both branches, atomically", () => {
      expect([...text.matchAll(/git push/g)]).toHaveLength(1);
      expect(text).toContain(
        'git push --atomic --force origin "$SNAPSHOT_BRANCH" "$RELEASE_BRANCH"',
      );
    });
  });
});
