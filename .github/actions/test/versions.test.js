import { describe, expect, it } from "vitest";
import { readVersions } from "../src/lib/toml.js";
import {
  compareVersions,
  generationOf,
  isHotfix,
  parseVersion,
  withoutQualifier,
} from "../src/lib/versions.js";

describe("parseVersion", () => {
  it.each([
    "7.0.10",
    "7.0.10.1",
    "2025.0.8",
    "7.1.0-M2",
    "7.1.0-RC1",
    "7.0.10-SNAPSHOT",
    "7.0.10-INTERNAL-SNAPSHOT",
    "7.0.10.1-SNAPSHOT",
  ])("reads %s", (version) => {
    expect(() => parseVersion(version)).not.toThrow();
  });

  it.each([
    "1.0.18.RELEASE",
    "7.0.10-rc1",
    "7.0.10-M",
    "7",
    "",
    "x",
    "7.0.10-SNAPSHOT-SNAPSHOT",
  ])("does not read %j, and says which version", (version) => {
    expect(() => parseVersion(version)).toThrow(`"${version}"`);
  });
});

describe("compareVersions", () => {
  // From the oldest to the newest.
  const ordered = [
    "7.0.9",
    "7.0.10-SNAPSHOT",
    "7.0.10-M1",
    "7.0.10-M2",
    "7.0.10-M10",
    "7.0.10-RC1",
    "7.0.10-RC2",
    "7.0.10",
    "7.0.10.1-SNAPSHOT",
    "7.0.10.1",
    "7.0.11",
    "7.1.0-M1",
    "7.1.0",
    "7.10.0",
    "2025.0.8",
    "2025.1.0",
    "2026.0.0-RC1",
  ];

  it("orders the versions", () => {
    const shuffled = [...ordered].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(ordered);
  });

  it("compares numbers as numbers, and not as text", () => {
    expect(compareVersions("7.0.10", "7.0.9")).toBeGreaterThan(0);
    expect(compareVersions("7.0.9", "7.0.10")).toBeLessThan(0);
  });

  it("is older for a missing number than for a hotfix", () => {
    expect(compareVersions("7.0.10", "7.0.10.1")).toBeLessThan(0);
    expect(compareVersions("7.0.10", "7.0.10.0")).toBe(0);
  });

  it("does not tell a snapshot from an internal snapshot", () => {
    expect(compareVersions("7.0.10-SNAPSHOT", "7.0.10-INTERNAL-SNAPSHOT")).toBe(
      0,
    );
  });
});

describe("generationOf", () => {
  it.each([
    ["7.0.10", "7.0"],
    ["7.0.10.1", "7.0"],
    ["2025.0.8", "2025.0"],
    ["7.1.0-RC1", "7.1"],
    ["5.2.27.RELEASE", "5.2"],
    ["7.0", "7.0"],
  ])("%s is of the generation %s", (version, generation) => {
    expect(generationOf(version)).toBe(generation);
  });

  it("does not take 7.10 for 7.1", () => {
    expect(generationOf("7.10.0")).toBe("7.10");
  });

  it("fails if there is none", () => {
    expect(() => generationOf("latest")).toThrow('"latest"');
  });
});

describe("isHotfix", () => {
  it("is a version of four numbers", () => {
    expect(isHotfix("7.0.10.1")).toBe(true);
    expect(isHotfix("7.0.10")).toBe(false);
    expect(isHotfix("7.1.0-RC1")).toBe(false);
  });
});

describe("withoutQualifier", () => {
  it("drops a milestone and a release candidate", () => {
    expect(withoutQualifier("7.1.0-RC1")).toBe("7.1.0");
    expect(withoutQualifier("7.1.0-M2")).toBe("7.1.0");
  });

  it("leaves the others", () => {
    expect(withoutQualifier("7.1.0")).toBe("7.1.0");
    expect(withoutQualifier("7.0.10.1")).toBe("7.0.10.1");
  });
});

describe("readVersions", () => {
  const toml = `# a comment
[versions]
micrometer = "1.16.7"
spring-framework   =   "7.0.9"
not-a-version = { a = "b" }
# commented = "1.0.0"
reactor = "2025.0.7"

[libraries]
reactor = "io.projectreactor:reactor-bom:2025.0.7"
other = "1.0.0"

[versions-other]
fake = "1.0.0"
`;

  it("reads the lines of the [versions] section, in order", () => {
    expect([...readVersions(toml)]).toEqual([
      ["micrometer", "1.16.7"],
      ["spring-framework", "7.0.9"],
      ["reactor", "2025.0.7"],
    ]);
  });

  it("reads nothing without a [versions] section", () => {
    expect(readVersions('[libraries]\na = "1"\n').size).toBe(0);
  });

  it("reads windows line endings", () => {
    expect([...readVersions('[versions]\r\na = "1.0.0"\r\n')]).toEqual([
      ["a", "1.0.0"],
    ]);
  });
});
