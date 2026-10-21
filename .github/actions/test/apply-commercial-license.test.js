import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCommercialLicense,
  BROADCOM_COPYRIGHT,
  BUNDLED_LICENSE,
  replaceHeader,
} from "../src/apply-commercial-license/index.js";
import { createRepo, git } from "./support/git-repo.js";
import { runAction } from "./support/run-action.js";

const APACHE = `/*
 * Copyright 2004-present the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */`;
const BODY = `

package org.springframework.example;

public class Greeter {
}
`;
const BROADCOM = `/*
${BROADCOM_COPYRIGHT}
 * Copyright 2004-present the original author or authors.
 */`;
const OSS_LICENSE = "Apache License\nVersion 2.0\n";

describe("replaceHeader", () => {
  it("replaces the Apache header with the Broadcom copyright, and keeps the original ones", () => {
    expect(replaceHeader(APACHE + BODY)).toBe(BROADCOM + BODY);
  });

  it("keeps every copyright line, as it was", () => {
    const text = `/*
 * Copyright 2002-2020 the original author or authors.
 * Copyright 2021-2026 Someone Else.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
class A {}`;
    expect(replaceHeader(text)).toBe(`/*
${BROADCOM_COPYRIGHT}
 * Copyright 2002-2020 the original author or authors.
 * Copyright 2021-2026 Someone Else.
 */
class A {}`);
  });

  it("has only the Broadcom line if the header had no copyright", () => {
    const text = `/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
class A {}`;
    expect(replaceHeader(text)).toBe(`/*
${BROADCOM_COPYRIGHT}
 */
class A {}`);
  });

  it("can be done again, with the same result", () => {
    const once = replaceHeader(APACHE + BODY);
    expect(replaceHeader(once)).toBe(once);
  });

  it.each([
    ["a file with no header", "package a;\nclass A {}\n"],
    [
      "another license",
      "/*\n * Copyright 2020 X.\n * Licensed under the MIT License.\n */\nclass A {}\n",
    ],
    [
      "an Apache header that is not the first comment",
      `package a;\n${APACHE}\nclass A {}\n`,
    ],
    ["an empty file", ""],
  ])("leaves %s", (_, text) => {
    expect(replaceHeader(text)).toBe(text);
  });

  it("does not take a later comment for the end of the header", () => {
    const text = `${APACHE}\n\n/* a comment */\nclass A {}\n`;
    expect(replaceHeader(text)).toBe(
      `${BROADCOM}\n\n/* a comment */\nclass A {}\n`,
    );
  });

  it("keeps windows line endings", () => {
    const windows = (APACHE + BODY).replaceAll("\n", "\r\n");
    const replaced = replaceHeader(windows);
    expect(replaced).toBe((BROADCOM + BODY).replaceAll("\n", "\r\n"));
    expect(replaced.replaceAll("\r\n", "").includes("\n")).toBe(false);
  });
});

describe("the bundled license", () => {
  it("is the commercial license, and not the Apache one", () => {
    const text = fs.readFileSync(BUNDLED_LICENSE, "utf8");
    expect(text).toContain("Foundation Agreement");
    expect(text).not.toContain("Apache License");
    expect(text.split("\n").length).toBeGreaterThan(1000);
  });
});

describe("applyCommercialLicense", () => {
  const files = {
    "LICENSE.txt": OSS_LICENSE,
    "src/main/java/a/Greeter.java": APACHE + BODY,
    "src/main/java/a/Other.java": "package a;\nclass Other {}\n",
    "src/main/java/a/Done.java": BROADCOM + BODY,
    "docs/Example.java.txt": APACHE + BODY, // not a Java file
  };
  const repo = (options) => createRepo(files, options);
  const read = (directory, file) =>
    fs.readFileSync(path.join(directory, file), "utf8");

  it("changes the headers of the Java files and the license, and nothing else", () => {
    const directory = repo();
    const { changed, java, license } = applyCommercialLicense({ directory });
    expect(changed.sort()).toEqual([
      "LICENSE.txt",
      "src/main/java/a/Greeter.java",
    ]);
    expect(java).toBe(1);
    expect(license).toBe(true);
    expect(read(directory, "src/main/java/a/Greeter.java")).toBe(
      BROADCOM + BODY,
    );
    expect(read(directory, "src/main/java/a/Other.java")).toBe(
      files["src/main/java/a/Other.java"],
    );
    expect(read(directory, "docs/Example.java.txt")).toBe(APACHE + BODY);
    expect(fs.readFileSync(path.join(directory, "LICENSE.txt"))).toEqual(
      fs.readFileSync(BUNDLED_LICENSE),
    );
    // the changes are left in the working tree
    expect(git(directory, "status", "--porcelain").split("\n").sort()).toEqual([
      " M LICENSE.txt",
      " M src/main/java/a/Greeter.java",
    ]);
  });

  it("is done again with nothing to change", () => {
    const directory = repo();
    applyCommercialLicense({ directory });
    git(directory, "add", "-A");
    git(directory, "commit", "-q", "-m", "done");
    const again = applyCommercialLicense({ directory });
    expect(again.changed).toEqual([]);
    expect(again.license).toBe(false);
    expect(git(directory, "status", "--porcelain")).toBe("");
  });

  it("creates LICENSE.txt if the project has none", () => {
    const directory = createRepo({ "a.txt": "a" });
    const result = applyCommercialLicense({ directory });
    expect(result.license).toBe(true);
    expect(fs.existsSync(path.join(directory, "LICENSE.txt"))).toBe(true);
  });

  it("takes another license if it is given one", () => {
    const directory = repo();
    const other = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "lic-")),
      "L.txt",
    );
    fs.writeFileSync(other, "My license\n");
    applyCommercialLicense({ directory, licenseFile: other });
    expect(read(directory, "LICENSE.txt")).toBe("My license\n");
  });

  it("fails for a license that does not exist", () => {
    expect(() =>
      applyCommercialLicense({
        directory: repo(),
        licenseFile: "/nonexistent/L.txt",
      }),
    ).toThrow("The license does not exist");
  });

  it("commits the changes if it is given a message, signed off, and only those files", () => {
    const directory = repo();
    fs.writeFileSync(path.join(directory, "unrelated.txt"), "x");
    git(directory, "add", "unrelated.txt");
    const result = applyCommercialLicense({
      directory,
      commitMessage: "Commercial changes for 7.0.1.1",
    });
    expect(result.commit).toBe(git(directory, "rev-parse", "HEAD"));
    expect(git(directory, "log", "-1", "--format=%B").trim()).toMatch(
      /^Commercial changes for 7\.0\.1\.1\n\nSigned-off-by: Alice <alice@example\.com>$/,
    );
    expect(
      git(directory, "show", "--format=", "--name-only", "HEAD")
        .split("\n")
        .sort(),
    ).toEqual(["LICENSE.txt", "src/main/java/a/Greeter.java"]);
    expect(git(directory, "status", "--porcelain")).toBe("A  unrelated.txt");
  });

  it("makes no commit if there is nothing to change", () => {
    const directory = repo();
    applyCommercialLicense({ directory, commitMessage: "first" });
    const before = git(directory, "rev-parse", "HEAD");
    const result = applyCommercialLicense({
      directory,
      commitMessage: "second",
    });
    expect(result.commit).toBe("");
    expect(git(directory, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses to commit if git does not know who commits, and changes nothing committed", () => {
    const directory = repo({ identity: false });
    const keep = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    for (const name of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "EMAIL",
    ]) {
      delete process.env[name];
    }
    try {
      expect(() =>
        applyCommercialLicense({ directory, commitMessage: "x" }),
      ).toThrow("git does not know who commits");
    } finally {
      process.env = keep;
    }
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
  });
});

// The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
describe.each([
  ["src/apply-commercial-license/index.js"],
  ["dist/apply-commercial-license/index.js"],
])("the program %s", (entry) => {
  const repo = () =>
    createRepo({
      "LICENSE.txt": OSS_LICENSE,
      "A.java": APACHE + BODY,
      "B.java": APACHE + BODY,
    });

  it("changes the files, and writes its outputs, with the license that it bundles", async () => {
    const directory = repo();
    const result = await runAction(entry, { path: directory });
    expect(result.code).toBe(0);
    expect(result.outputs["java-files"]).toBe("2");
    expect(result.outputs.license).toBe("true");
    expect(JSON.parse(result.outputs.changed).sort()).toEqual([
      "A.java",
      "B.java",
      "LICENSE.txt",
    ]);
    expect(result.outputs.commit).toBe("");
    expect(
      fs.readFileSync(path.join(directory, "LICENSE.txt"), "utf8"),
    ).toContain("Foundation Agreement");
    expect(fs.readFileSync(path.join(directory, "A.java"), "utf8")).toBe(
      BROADCOM + BODY,
    );
  });

  it("commits if it is given a message", async () => {
    const directory = repo();
    const result = await runAction(entry, {
      path: directory,
      "commit-message": "Commercial changes for 7.0.1.1",
    });
    expect(result.code).toBe(0);
    expect(result.outputs.commit).toBe(git(directory, "rev-parse", "HEAD"));
    expect(git(directory, "status", "--porcelain")).toBe("");
  });

  it("fails with an error that GitHub shows", async () => {
    const result = await runAction(entry, {
      path: repo(),
      "license-file": "/nonexistent/L.txt",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("::error::The license does not exist");
  });
});
