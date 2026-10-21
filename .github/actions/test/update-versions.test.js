import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitMessage,
  updatesOf,
  updateVersions,
} from "../src/update-versions/index.js";
import { createRepo, git } from "./support/git-repo.js";
import { runAction } from "./support/run-action.js";

const TOML = "gradle/libs.versions.toml";
const catalog = `[versions]
micrometer = "1.16.7"
reactor = "2025.0.7"
spring-framework = "7.0.9"

[libraries]
reactor = "io.projectreactor:reactor-bom:2025.0.7"
`;

const repo = (options) => createRepo({ [TOML]: catalog }, options);
const messages = (directory, count) =>
  git(directory, "log", `-${count}`, "--format=%B%x00")
    .split("\0")
    .map((message) => message.trim())
    .filter(Boolean);
const read = (directory) => fs.readFileSync(path.join(directory, TOML), "utf8");

describe("commitMessage", () => {
  it("closes the issue", () => {
    expect(
      commitMessage({
        dependency: "spring-framework",
        version: "7.0.10",
        issue: "123",
      }),
    ).toBe("Update spring-framework to 7.0.10\n\nCloses gh-123");
  });

  it("has no Closes line without an issue", () => {
    expect(commitMessage({ dependency: "reactor", version: "2025.0.8" })).toBe(
      "Update reactor to 2025.0.8",
    );
  });
});

describe("updatesOf", () => {
  it("lists the updates in the order of the names", () => {
    expect(
      updatesOf(
        { b: { version: "2", issue: 7 }, a: { version: "1", issue: "8" } },
        true,
      ),
    ).toEqual([
      { dependency: "a", version: "1", issue: "8" },
      { dependency: "b", version: "2", issue: "7" },
    ]);
  });

  it("takes a version as a string, if no issue is needed", () => {
    expect(updatesOf({ a: "1.0.0" }, false)).toEqual([
      { dependency: "a", version: "1.0.0", issue: undefined },
    ]);
  });

  it("wants an issue, unless told it is not needed", () => {
    expect(() => updatesOf({ a: "1.0.0" }, true)).toThrow(
      "The update of a has no issue",
    );
    expect(() => updatesOf({ a: { version: "1.0.0" } }, true)).toThrow(
      "has no issue",
    );
  });

  it.each(["abc", "0", "-1", "1.5", "#12"])(
    "does not take %j for an issue",
    (issue) => {
      expect(() => updatesOf({ a: { version: "1", issue } }, true)).toThrow(
        "must be a number",
      );
    },
  );

  it("wants a version", () => {
    expect(() => updatesOf({ a: { issue: 1 } }, true)).toThrow(
      "has no version",
    );
    expect(() => updatesOf({ a: null }, false)).toThrow("has no version");
  });

  it.each([null, [], "text", 7])("wants an object, not %j", (changes) => {
    expect(() => updatesOf(changes, true)).toThrow("must be an object");
  });
});

describe("updateVersions", () => {
  const changes = {
    "spring-framework": { version: "7.0.10", issue: 123 },
    micrometer: { version: "1.16.8", issue: 124 },
  };

  it("makes one commit for each version, in the order of the names", () => {
    const directory = repo();
    const commits = updateVersions({ directory, tomlPath: TOML, changes });
    expect(commits.map((c) => c.dependency)).toEqual([
      "micrometer",
      "spring-framework",
    ]);
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("3"); // the first and two
    expect(messages(directory, 2)).toEqual([
      expect.stringMatching(
        /^Update spring-framework to 7\.0\.10\n\nCloses gh-123\n\nSigned-off-by: Alice <alice@example\.com>$/,
      ),
      expect.stringMatching(
        /^Update micrometer to 1\.16\.8\n\nCloses gh-124\n\nSigned-off-by: Alice <alice@example\.com>$/,
      ),
    ]);
    expect(commits[0].commit).toBe(git(directory, "rev-parse", "HEAD~1"));
    expect(commits[1].commit).toBe(git(directory, "rev-parse", "HEAD"));
  });

  it("changes only the line of its version in every commit", () => {
    const directory = repo();
    updateVersions({ directory, tomlPath: TOML, changes });
    expect(git(directory, "show", "--format=", "--name-only", "HEAD")).toBe(
      TOML,
    );
    expect(git(directory, "show", "--format=", "--stat", "HEAD")).toContain(
      "1 insertion(+), 1 deletion(-)",
    );
    expect(read(directory)).toBe(
      catalog
        .replace('micrometer = "1.16.7"', 'micrometer = "1.16.8"')
        .replace('spring-framework = "7.0.9"', 'spring-framework = "7.0.10"'),
    );
  });

  it("commits as the identity of git, not signed", () => {
    const directory = repo();
    updateVersions({ directory, tomlPath: TOML, changes });
    expect(git(directory, "log", "-1", "--format=%an <%ae> %GS")).toBe(
      "Alice <alice@example.com> ",
    );
  });

  it("needs no issue if told so, and then has no Closes line", () => {
    const directory = repo();
    updateVersions({
      directory,
      tomlPath: TOML,
      changes: { reactor: "2025.0.8-INTERNAL-SNAPSHOT" },
      requireIssue: false,
    });
    expect(messages(directory, 1)[0]).toMatch(
      /^Update reactor to 2025\.0\.8-INTERNAL-SNAPSHOT\n\nSigned-off-by: Alice/,
    );
    expect(messages(directory, 1)[0]).not.toContain("Closes");
  });

  it("leaves a version that has the new version already, with no commit", () => {
    const directory = repo();
    const log = [];
    const commits = updateVersions({
      directory,
      tomlPath: TOML,
      changes: { reactor: "2025.0.7", micrometer: "1.16.8" },
      requireIssue: false,
      log: (line) => log.push(line),
    });
    expect(commits.map((c) => c.dependency)).toEqual(["micrometer"]);
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("2");
    expect(log).toContain("reactor is 2025.0.7 already, no commit");
  });

  it("does nothing for no versions", () => {
    const directory = repo();
    expect(updateVersions({ directory, tomlPath: TOML, changes: {} })).toEqual(
      [],
    );
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("checks everything before the first commit", () => {
    const directory = repo();
    // the second one is wrong, and the first must not have been done
    expect(() =>
      updateVersions({
        directory,
        tomlPath: TOML,
        changes: {
          micrometer: { version: "1.16.8", issue: 1 },
          nothing: { version: "1.0.0", issue: 2 },
        },
      }),
    ).toThrow("has no version nothing");
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
    expect(read(directory)).toBe(catalog);
    expect(() =>
      updateVersions({
        directory,
        tomlPath: TOML,
        changes: {
          micrometer: { version: "1.16.8", issue: 1 },
          reactor: "2025.0.8",
        },
      }),
    ).toThrow("The update of reactor has no issue");
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("fails for a catalog that has changes that are not committed", () => {
    const directory = repo();
    fs.appendFileSync(path.join(directory, TOML), "# edited\n");
    expect(() =>
      updateVersions({ directory, tomlPath: TOML, changes }),
    ).toThrow("has changes that are not committed");
  });

  it("does not commit other changes of the repository", () => {
    const directory = repo();
    fs.writeFileSync(path.join(directory, "other.txt"), "other");
    git(directory, "add", "other.txt");
    updateVersions({ directory, tomlPath: TOML, changes });
    expect(git(directory, "show", "--format=", "--name-only", "HEAD")).toBe(
      TOML,
    );
    expect(git(directory, "status", "--porcelain")).toBe("A  other.txt");
  });

  it("fails for a catalog that does not exist", () => {
    expect(() =>
      updateVersions({ directory: repo(), tomlPath: "nothing.toml", changes }),
    ).toThrow("The version catalog does not exist");
  });

  describe("when git does not know who commits", () => {
    // Without an identity, git makes one up from the user and the machine
    // (Rob Winch <rw036207@host.local>), so the action must refuse.
    const withoutIdentity = (action) => {
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
        return action();
      } finally {
        process.env = keep;
      }
    };

    it("fails with what to do, and commits nothing", () => {
      const directory = repo({ identity: false });
      withoutIdentity(() =>
        expect(() =>
          updateVersions({ directory, tomlPath: TOML, changes }),
        ).toThrow(
          /git does not know who commits: set user.name and user.email/,
        ),
      );
      expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
      expect(read(directory)).toBe(catalog);
    });

    it("does not need it when there is nothing to commit", () => {
      const directory = repo({ identity: false });
      withoutIdentity(() =>
        expect(
          updateVersions({
            directory,
            tomlPath: TOML,
            changes: { micrometer: "1.16.7" },
            requireIssue: false,
          }),
        ).toEqual([]),
      );
    });

    it("takes the identity of the variables", () => {
      const directory = repo({ identity: false });
      withoutIdentity(() => {
        process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Bot";
        process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL =
          "bot@example.com";
        updateVersions({ directory, tomlPath: TOML, changes });
      });
      expect(git(directory, "log", "-1", "--format=%an <%ae>")).toBe(
        "Bot <bot@example.com>",
      );
    });
  });
});

// The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
describe.each([
  ["src/update-versions/index.js"],
  ["dist/update-versions/index.js"],
])("the program %s", (entry) => {
  it("makes the commits, and writes its outputs", async () => {
    const directory = repo();
    const result = await runAction(entry, {
      versions: JSON.stringify({
        micrometer: { version: "1.16.8", issue: 124 },
      }),
      path: directory,
    });
    expect(result.code).toBe(0);
    expect(result.outputs.count).toBe("1");
    const [commit] = JSON.parse(result.outputs.commits);
    expect(commit).toMatchObject({
      dependency: "micrometer",
      version: "1.16.8",
      issue: "124",
    });
    expect(commit.commit).toBe(git(directory, "rev-parse", "HEAD"));
  });

  it("takes the issues as not needed", async () => {
    const directory = repo();
    const result = await runAction(entry, {
      versions: JSON.stringify({ reactor: "2025.0.8-INTERNAL-SNAPSHOT" }),
      "require-issue": "false",
      path: directory,
    });
    expect(result.code).toBe(0);
    expect(messages(directory, 1)[0]).not.toContain("Closes");
  });

  it("fails with an error that GitHub shows, and commits nothing", async () => {
    const directory = repo();
    const result = await runAction(entry, {
      versions: JSON.stringify({ reactor: "2025.0.8" }),
      path: directory,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "::error::The update of reactor has no issue",
    );
    expect(git(directory, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("fails for versions that are not JSON", async () => {
    const result = await runAction(entry, {
      versions: "{ not json",
      path: repo(),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("The input versions is not JSON");
  });
});
