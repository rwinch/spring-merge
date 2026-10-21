import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot } from "./support/world.js";
import { createRepo, git } from "./support/git-repo.js";

const scripts = path.join(projectRoot, ".github", "scripts");

// A script as the workflow runs it: with bash, and no configuration of the developer's.
function run(script, args, env, cwd) {
  const result = spawnSync("bash", [path.join(scripts, script), ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: "/nonexistent",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...env,
    },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const plan = (REF_NAME, VERSION) => {
  const result = run("plan.sh", [], { REF_NAME, VERSION });
  return {
    ...result,
    outputs: Object.fromEntries(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    ),
  };
};

describe("plan.sh", () => {
  it("builds the release and an internal snapshot for a frozen disclosure", () => {
    const { code, outputs } = plan("disclosure/frozen/7.0.x", "7.0.1-SNAPSHOT");
    expect(code).toBe(0);
    expect(outputs).toEqual({
      release: "true",
      kind: "frozen",
      "base-version": "7.0.1-SNAPSHOT",
      hotfix: "false",
      "snapshot-branch": "disclosure/7.0.1-INTERNAL-SNAPSHOT",
      "snapshot-version": "7.0.1-INTERNAL-SNAPSHOT",
    });
  });

  it("names the internal snapshot of a .0 version without the release candidate", () => {
    const { outputs } = plan("disclosure/frozen/main", "7.1.0-SNAPSHOT");
    expect(outputs["snapshot-branch"]).toBe(
      "disclosure/7.1.0-INTERNAL-SNAPSHOT",
    );
    expect(outputs["snapshot-version"]).toBe("7.1.0-INTERNAL-SNAPSHOT");
    expect(outputs["base-version"]).toBe("7.1.0-SNAPSHOT");
  });

  it("builds a hotfix for an active disclosure, and no internal snapshot", () => {
    const { code, outputs } = plan("disclosure/active/7.0.x", "7.0.1-SNAPSHOT");
    expect(code).toBe(0);
    expect(outputs).toEqual({
      release: "true",
      kind: "active",
      "base-version": "7.0.1.1-SNAPSHOT",
      hotfix: "true",
      "snapshot-branch": "disclosure/7.0.1.1-SNAPSHOT",
      "snapshot-version": "7.0.1.1-SNAPSHOT",
    });
  });

  it("builds nothing for an active disclosure that is not a patch release", () => {
    const { code, outputs, stderr } = plan(
      "disclosure/active/main",
      "7.1.0-SNAPSHOT",
    );
    expect(code).toBe(0);
    expect(outputs).toEqual({ release: "false", kind: "active" });
    expect(stderr).toContain("has no hotfix");
  });

  it.each([
    [
      "a branch that is not a disclosure",
      "feature/x",
      "7.0.1-SNAPSHOT",
      "is not a disclosure branch",
    ],
    [
      "a version that is not a snapshot",
      "disclosure/frozen/7.0.x",
      "7.0.1",
      "expected <major>.<minor>.<patch>-SNAPSHOT",
    ],
    [
      "a milestone as a snapshot",
      "disclosure/frozen/7.0.x",
      "7.1.0-M1-SNAPSHOT",
      "expected <major>.<minor>.<patch>-SNAPSHOT",
    ],
    [
      "a hotfix on a frozen disclosure",
      "disclosure/frozen/7.0.x",
      "7.0.1.1-SNAPSHOT",
      "has no internal snapshot",
    ],
    [
      "a hotfix on an active disclosure",
      "disclosure/active/7.0.x",
      "7.0.1.1-SNAPSHOT",
      "a hotfix already",
    ],
  ])("fails for %s", (_, ref, version, message) => {
    const { code, stderr, stdout } = plan(ref, version);
    expect(code).toBe(1);
    expect(stderr).toContain(`::error::`);
    expect(stderr).toContain(message);
    expect(stdout).toBe("");
  });

  it("needs its input", () => {
    expect(run("plan.sh", [], { VERSION: "7.0.1-SNAPSHOT" }).stderr).toContain(
      "REF_NAME is required",
    );
    expect(
      run("plan.sh", [], { REF_NAME: "disclosure/frozen/x" }).stderr,
    ).toContain("VERSION is required");
  });
});

describe("set-version.sh", () => {
  const repo = (properties = "version=7.0.1-SNAPSHOT\n") =>
    createRepo({ "gradle.properties": properties });

  it("sets the version in a commit of its own, signed off", () => {
    const directory = repo();
    const { code, stdout } = run(
      "set-version.sh",
      ["7.0.1", "Release 7.0.1"],
      {},
      directory,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Release 7.0.1");
    expect(
      fs.readFileSync(path.join(directory, "gradle.properties"), "utf8"),
    ).toBe("version=7.0.1\n");
    expect(git(directory, "log", "-1", "--format=%B").trim()).toBe(
      "Release 7.0.1\n\nSigned-off-by: Alice <alice@example.com>",
    );
    expect(git(directory, "status", "--porcelain")).toBe("");
  });

  it("changes only the line of the version", () => {
    const directory = repo(
      "org.gradle.jvmargs=-Xmx2g\nversion=7.0.1-SNAPSHOT\n# a comment: version=1\nother=a\n",
    );
    run("set-version.sh", ["7.0.1", "Release 7.0.1"], {}, directory);
    expect(
      fs.readFileSync(path.join(directory, "gradle.properties"), "utf8"),
    ).toBe(
      "org.gradle.jvmargs=-Xmx2g\nversion=7.0.1\n# a comment: version=1\nother=a\n",
    );
  });

  it("keeps windows line endings", () => {
    const directory = repo("version=7.0.1-SNAPSHOT\r\nother=a\r\n");
    run("set-version.sh", ["7.0.1", "Release 7.0.1"], {}, directory);
    expect(
      fs.readFileSync(path.join(directory, "gradle.properties"), "utf8"),
    ).toBe("version=7.0.1\r\nother=a\r\n");
  });

  it("takes a release candidate, and an internal snapshot", () => {
    const directory = repo();
    run("set-version.sh", ["7.1.0-RC1", "Release 7.1.0-RC1"], {}, directory);
    expect(
      fs.readFileSync(path.join(directory, "gradle.properties"), "utf8"),
    ).toBe("version=7.1.0-RC1\n");
    run("set-version.sh", ["7.1.0-INTERNAL-SNAPSHOT", "Set"], {}, directory);
    expect(
      fs.readFileSync(path.join(directory, "gradle.properties"), "utf8"),
    ).toBe("version=7.1.0-INTERNAL-SNAPSHOT\n");
  });

  it("fails if the version is that already, and commits nothing", () => {
    const directory = repo("version=7.0.1\n");
    const { code, stderr } = run(
      "set-version.sh",
      ["7.0.1", "Release 7.0.1"],
      {},
      directory,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("has the version 7.0.1 already");
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("fails if there is no line version", () => {
    const directory = repo("other=a\n");
    expect(
      run("set-version.sh", ["7.0.1", "x"], {}, directory).stderr,
    ).toContain("has no line version=");
  });

  it.each(["", "7.0.1; rm -rf /", "$(id)", "a b", "-x"])(
    "does not write %j",
    (version) => {
      const directory = repo();
      const { code } = run("set-version.sh", [version, "x"], {}, directory);
      expect(code).not.toBe(0);
      expect(
        fs.readFileSync(path.join(directory, "gradle.properties"), "utf8"),
      ).toBe("version=7.0.1-SNAPSHOT\n");
    },
  );

  it("fails if git does not know who commits, and changes nothing committed", () => {
    const directory = createRepo(
      { "gradle.properties": "version=7.0.1-SNAPSHOT\n" },
      { identity: false },
    );
    const { code, stderr } = run(
      "set-version.sh",
      ["7.0.1", "Release 7.0.1"],
      {},
      directory,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("git does not know who commits");
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: directory,
        encoding: "utf8",
      }),
    ).toBe("");
  });
});
