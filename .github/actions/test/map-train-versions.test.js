import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { mapVersions } from "../src/map-train-versions/index.js";
import { readVersions } from "../src/lib/toml.js";
import { runAction } from "./support/run-action.js";

const fixtures = path.join(import.meta.dirname, "fixtures");
const toml = path.join(fixtures, "libs.versions.toml");

const readTrain = (branch) => {
  const directory = path.join(fixtures, "train", branch);
  return {
    releaseVersions: JSON.parse(
      fs.readFileSync(path.join(directory, "release-versions.json"), "utf8"),
    ),
    train: parse(fs.readFileSync(path.join(directory, "train.yml"), "utf8")),
  };
};

const map = (options = {}, versions = readVersions(readFile(toml))) =>
  mapVersions({ ...readTrain("2026.11.19"), versions, ...options });
function readFile(file) {
  return fs.readFileSync(file, "utf8");
}
const catalog = (entries) => new Map(Object.entries(entries));

describe("the four ways of the release workflow, with the practice train", () => {
  it("the release branch: the newest version of the generation, no hotfix", () => {
    expect(map().changes).toEqual({
      micrometer: "1.16.8",
      reactor: "2025.0.8",
      "spring-data-bom": "2025.1.8",
      "spring-framework": "7.0.10",
      "spring-ldap": "4.0.6",
    });
  });

  it("the release branch of a hotfix: a hotfix if there is one", () => {
    expect(map({ preferHotfix: true }).changes).toEqual({
      micrometer: "1.16.8", // no hotfix in the train
      reactor: "2025.0.8", // none either
      "spring-data-bom": "2025.1.8.1",
      "spring-framework": "7.0.10.1",
      "spring-ldap": "4.0.6.1",
    });
  });

  it("the snapshot branch of a frozen disclosure: an internal snapshot of each", () => {
    expect(map({ suffix: "-INTERNAL-SNAPSHOT" }).changes).toEqual({
      micrometer: "1.16.8-INTERNAL-SNAPSHOT",
      reactor: "2025.0.8-INTERNAL-SNAPSHOT", // joined, but not ready: that is enough
      "spring-data-bom": "2025.1.8-INTERNAL-SNAPSHOT",
      "spring-framework": "7.0.10-INTERNAL-SNAPSHOT",
      "spring-ldap": "4.0.6-INTERNAL-SNAPSHOT",
    });
  });

  it("the snapshot branch of a hotfix: a snapshot of the hotfix, else the internal snapshot", () => {
    expect(
      map({
        preferHotfix: true,
        hotfixSuffix: "-SNAPSHOT",
        suffix: "-INTERNAL-SNAPSHOT",
      }).changes,
    ).toEqual({
      micrometer: "1.16.8-INTERNAL-SNAPSHOT",
      reactor: "2025.0.8-INTERNAL-SNAPSHOT",
      "spring-data-bom": "2025.1.8.1-SNAPSHOT",
      "spring-framework": "7.0.10.1-SNAPSHOT",
      "spring-ldap": "4.0.6.1-SNAPSHOT",
    });
  });

  it("logs what it did for every version", () => {
    const { log } = map();
    expect(log).toHaveLength(5);
    expect(log).toContain("spring-framework 7.0.9: to 7.0.10");
  });
});

describe("what it does not touch", () => {
  it("leaves the versions that are not a project of the train", () => {
    const { changes } = map();
    expect(changes).not.toHaveProperty("org-aspectj");
    expect(changes).not.toHaveProperty("com-squareup-okhttp3");
  });

  it("does not look at the projects of the train that the catalog has not", () => {
    // the train has spring-boot, and the catalog does not
    expect(Object.keys(map().changes)).not.toContain("spring-boot");
    expect(map({}, catalog({ "spring-framework": "7.0.9" })).changes).toEqual({
      "spring-framework": "7.0.10",
    });
  });

  it("leaves a version that has been updated already", () => {
    const { changes, log } = map({}, catalog({ "spring-framework": "7.0.10" }));
    expect(changes).toEqual({});
    expect(log).toEqual([
      "spring-framework 7.0.10: already 7.0.10, left alone",
    ]);
  });

  it("updates a snapshot version to the internal snapshot, which is not the same", () => {
    expect(
      map(
        { suffix: "-INTERNAL-SNAPSHOT" },
        catalog({ "spring-framework": "7.0.10-SNAPSHOT" }),
      ).changes,
    ).toEqual({ "spring-framework": "7.0.10-INTERNAL-SNAPSHOT" });
  });

  it("leaves a version that is already the one it would be changed to, with the suffix", () => {
    expect(
      map(
        { suffix: "-INTERNAL-SNAPSHOT" },
        catalog({ "spring-framework": "7.0.10-INTERNAL-SNAPSHOT" }),
      ).changes,
    ).toEqual({});
  });

  it("leaves a release of the train that the catalog has, when a snapshot is asked for", () => {
    // 7.0.10 is released: there is no snapshot of it to go to
    const { changes, log } = map(
      { suffix: "-INTERNAL-SNAPSHOT" },
      catalog({ "spring-framework": "7.0.10" }),
    );
    expect(changes).toEqual({});
    expect(log[0]).toContain("already the 7.0.10 of the train");
  });

  it("goes forward from a milestone to the snapshot of the next release candidate", () => {
    const releaseVersions = { x: ["7.1.0-RC1"] };
    expect(
      mapVersions({
        releaseVersions,
        versions: catalog({ x: "7.1.0-M3" }),
        requireJoined: false,
        suffix: "-INTERNAL-SNAPSHOT",
      }).changes,
    ).toEqual({ x: "7.1.0-INTERNAL-SNAPSHOT" });
  });

  it("leaves a version whose generation is not in the train", () => {
    const { changes, log } = map({}, catalog({ micrometer: "1.15.0" }));
    expect(changes).toEqual({});
    expect(log[0]).toContain("no version of 1.15 to go to");
  });

  it("does not take a version of another generation, such as 7.1.0-RC1 for 7.0", () => {
    expect(
      map({}, catalog({ "spring-framework": "7.0.9" })).changes[
        "spring-framework"
      ],
    ).toBe("7.0.10");
  });

  it("does not mix up 7.1 and 7.10", () => {
    const releaseVersions = { x: ["7.10.0", "7.1.5"] };
    expect(
      mapVersions({
        releaseVersions,
        versions: catalog({ x: "7.1.0" }),
        requireJoined: false,
      }).changes,
    ).toEqual({ x: "7.1.5" });
  });
});

describe("joined", () => {
  it("leaves a version that has not joined the train, if joining is required", () => {
    const releaseVersions = { ...readTrain("2026.11.19").releaseVersions };
    const train = structuredClone(readTrain("2026.11.19").train);
    delete train.releases["spring-ldap"]["4.0.6"];
    const { changes, log } = mapVersions({
      releaseVersions,
      train,
      versions: catalog({ "spring-ldap": "4.0.5", micrometer: "1.16.7" }),
    });
    expect(changes).toEqual({ micrometer: "1.16.8" });
    expect(log).toContain(
      "spring-ldap 4.0.5: 4.0.6 has not joined the train, left alone",
    );
  });

  it("changes it if joining is not required", () => {
    const train = structuredClone(readTrain("2026.11.19").train);
    delete train.releases["spring-ldap"]["4.0.6"];
    expect(
      mapVersions({
        releaseVersions: readTrain("2026.11.19").releaseVersions,
        train,
        versions: catalog({ "spring-ldap": "4.0.5" }),
        requireJoined: false,
      }).changes,
    ).toEqual({ "spring-ldap": "4.0.6" });
  });

  it("does not need the train if joining is not required", () => {
    expect(
      mapVersions({
        releaseVersions: readTrain("2026.11.19").releaseVersions,
        versions: catalog({ "spring-ldap": "4.0.5" }),
        requireJoined: false,
      }).changes,
    ).toEqual({ "spring-ldap": "4.0.6" });
  });

  it("needs the train if joining is required", () => {
    expect(() =>
      mapVersions({
        releaseVersions: readTrain("2026.11.19").releaseVersions,
        versions: catalog({ "spring-ldap": "4.0.5" }),
      }),
    ).toThrow("The train (train.yml) is needed");
  });

  it("looks at the hotfix that was chosen, and not at the version before it", () => {
    const train = structuredClone(readTrain("2026.11.19").train);
    delete train.releases["spring-framework"]["7.0.10.1"]; // the hotfix has not joined
    const { changes, log } = mapVersions({
      releaseVersions: readTrain("2026.11.19").releaseVersions,
      train,
      versions: catalog({ "spring-framework": "7.0.9" }),
      preferHotfix: true,
    });
    expect(changes).toEqual({});
    expect(log[0]).toContain("7.0.10.1 has not joined");
  });

  it("a train where spring-ldap is not known leaves it alone", () => {
    const { releaseVersions, train } = readTrain("2027.01.14");
    expect(
      mapVersions({
        releaseVersions,
        train,
        versions: catalog({ "spring-ldap": "4.0.5" }),
      }).changes,
    ).toEqual({});
  });
});

describe("milestones and release candidates", () => {
  const releaseVersions = { x: ["7.1.0-M2", "7.1.0-RC1", "7.0.9"] };

  it("goes to the newest of the generation, a release candidate over a milestone", () => {
    expect(
      mapVersions({
        releaseVersions,
        versions: catalog({ x: "7.1.0-M1" }),
        requireJoined: false,
      }).changes,
    ).toEqual({ x: "7.1.0-RC1" });
  });

  it("drops the release candidate for a snapshot: it never carries one", () => {
    expect(
      mapVersions({
        releaseVersions,
        versions: catalog({ x: "7.1.0-M1" }),
        requireJoined: false,
        suffix: "-INTERNAL-SNAPSHOT",
      }).changes,
    ).toEqual({ x: "7.1.0-INTERNAL-SNAPSHOT" });
  });
});

describe("what is wrong", () => {
  it("fails if the catalog has a newer version than the train", () => {
    expect(() => map({}, catalog({ micrometer: "1.16.9" }))).toThrow(
      "micrometer is 1.16.9, which is newer than the 1.16.8 of the train",
    );
  });

  it("fails if the catalog has a hotfix and the train does not give one", () => {
    expect(() => map({}, catalog({ "spring-framework": "7.0.11" }))).toThrow(
      "newer than the 7.0.10",
    );
    expect(() => map({}, catalog({ "spring-framework": "7.0.10.1" }))).toThrow(
      "newer than the 7.0.10",
    );
  });

  it("fails if a version of the catalog cannot be read", () => {
    expect(() => map({}, catalog({ micrometer: "latest" }))).toThrow(
      '"latest"',
    );
  });

  it("fails if a version of the train cannot be ordered", () => {
    expect(() =>
      mapVersions({
        releaseVersions: { x: ["1.0.18.RELEASE"] },
        versions: catalog({ x: "1.0.1" }),
        requireJoined: false,
      }),
    ).toThrow('"1.0.18.RELEASE"');
  });
});

// The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
describe.each([
  ["src/map-train-versions/index.js"],
  ["dist/map-train-versions/index.js"],
])("the program %s", (entry) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "map-train-"));
  const { train } = readTrain("2026.11.19");
  fs.writeFileSync(path.join(directory, "train.json"), JSON.stringify(train));
  fs.copyFileSync(
    path.join(fixtures, "train", "2026.11.19", "release-versions.json"),
    path.join(directory, "release-versions.json"),
  );
  const inputs = (more = {}) => ({
    "release-versions-file": path.join(directory, "release-versions.json"),
    "train-file": path.join(directory, "train.json"),
    "toml-path": toml,
    ...more,
  });

  it("writes its outputs", async () => {
    const result = await runAction(entry, inputs({ "prefer-hotfix": "true" }));
    expect(result.code).toBe(0);
    expect(result.outputs.count).toBe("5");
    expect(JSON.parse(result.outputs.versions)).toEqual({
      micrometer: "1.16.8",
      reactor: "2025.0.8",
      "spring-data-bom": "2025.1.8.1",
      "spring-framework": "7.0.10.1",
      "spring-ldap": "4.0.6.1",
    });
    expect(result.stdout).toContain("spring-framework 7.0.9: to 7.0.10.1");
  });

  it("takes the suffixes", async () => {
    const result = await runAction(
      entry,
      inputs({ suffix: "-INTERNAL-SNAPSHOT" }),
    );
    expect(JSON.parse(result.outputs.versions)["spring-framework"]).toBe(
      "7.0.10-INTERNAL-SNAPSHOT",
    );
  });

  it("takes the versions as JSON instead of files", async () => {
    const result = await runAction(entry, {
      "release-versions": JSON.stringify({ "spring-ldap": ["4.0.6"] }),
      "toml-path": toml,
      "require-joined": "false",
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.outputs.versions)).toEqual({
      "spring-ldap": "4.0.6",
    });
  });

  it("has no versions to change as an empty object", async () => {
    const result = await runAction(entry, {
      "release-versions": "{}",
      "toml-path": toml,
      "require-joined": "false",
    });
    expect(result.code).toBe(0);
    expect(result.outputs.versions).toBe("{}");
    expect(result.outputs.count).toBe("0");
  });

  it("fails with an error that GitHub shows", async () => {
    const newer = path.join(directory, "newer.toml");
    fs.writeFileSync(newer, '[versions]\nmicrometer = "1.16.9"\n');
    const result = await runAction(entry, inputs({ "toml-path": newer }));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "::error::micrometer is 1.16.9, which is newer than the 1.16.8 of the train",
    );
  });

  it("fails if there is no train versions, or no catalog", async () => {
    expect((await runAction(entry, { "toml-path": toml })).stdout).toContain(
      "release-versions-file (or release-versions) is required",
    );
    expect(
      (await runAction(entry, inputs({ "toml-path": "/nonexistent.toml" })))
        .stdout,
    ).toContain("The version catalog does not exist");
  });
});
