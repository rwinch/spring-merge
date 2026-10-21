import { describe, expect, it } from "vitest";
import { readVersions, setVersion } from "../src/lib/toml.js";

const toml = `# a comment: micrometer = "0.0.0"
[versions]
micrometer = "1.16.7"
spring-framework   =   "7.0.9"${"   "}
reactor = "2025.0.7"

[libraries]
reactor = "io.projectreactor:reactor-bom:2025.0.7"
io-micrometer-micrometer-bom = { module = "io.micrometer:micrometer-bom", version.ref = "micrometer" }
`;

describe("setVersion", () => {
  it("changes the version, and nothing else", () => {
    const changed = setVersion(toml, "micrometer", "1.16.8");
    expect(changed).toBe(
      toml.replace('micrometer = "1.16.7"', 'micrometer = "1.16.8"'),
    );
  });

  it("keeps the spaces of the line, and what follows the value", () => {
    expect(setVersion(toml, "spring-framework", "7.0.10")).toContain(
      'spring-framework   =   "7.0.10"   \n',
    );
  });

  it("does not touch a library of the same name", () => {
    const changed = setVersion(toml, "reactor", "2025.0.8");
    expect(changed).toContain('reactor = "2025.0.8"\n\n[libraries]');
    expect(changed).toContain(
      'reactor = "io.projectreactor:reactor-bom:2025.0.7"',
    );
  });

  it("does not touch a comment", () => {
    expect(setVersion(toml, "micrometer", "1.16.8")).toContain(
      '# a comment: micrometer = "0.0.0"',
    );
  });

  it("keeps windows line endings", () => {
    const windows = toml.replaceAll("\n", "\r\n");
    const changed = setVersion(windows, "micrometer", "1.16.8");
    expect(changed).toBe(
      windows.replace('micrometer = "1.16.7"', 'micrometer = "1.16.8"'),
    );
    expect(changed.includes("\r\n")).toBe(true);
    expect(changed.replaceAll("\r\n", "").includes("\n")).toBe(false);
  });

  it("is read back by readVersions", () => {
    const changed = setVersion(toml, "reactor", "2025.0.8");
    expect(readVersions(changed).get("reactor")).toBe("2025.0.8");
    expect(readVersions(changed).get("micrometer")).toBe("1.16.7");
  });

  it("fails for a version that is not in the [versions] section", () => {
    expect(() => setVersion(toml, "io-micrometer-micrometer-bom", "1")).toThrow(
      "has no version io-micrometer-micrometer-bom",
    );
    expect(() => setVersion(toml, "nothing", "1.0.0")).toThrow(
      "has no version nothing",
    );
  });

  it.each(['1.0.0"', "1.0.0\n", "", "a b", undefined])(
    "does not write %j",
    (value) => {
      expect(() => setVersion(toml, "micrometer", value)).toThrow(
        "is not a version to write",
      );
    },
  );
});
