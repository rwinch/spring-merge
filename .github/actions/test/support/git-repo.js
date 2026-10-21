import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs git in a directory, and returns what it printed without the last newline. */
export function git(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\n$/, "");
}

/**
 * A new git repository in a temporary directory, with the files (an object from the
 * path to the content) in its first commit. Its identity is Alice, for the commits that
 * are made in it, and nothing is signed.
 */
export function createRepo(files, { identity = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-"));
  git(directory, "init", "-q", "-b", "main");
  if (identity) {
    git(directory, "config", "user.name", "Alice");
    git(directory, "config", "user.email", "alice@example.com");
  }
  git(directory, "config", "commit.gpgsign", "false");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  }
  git(directory, "add", "-A");
  git(
    directory,
    "-c",
    "user.name=Setup",
    "-c",
    "user.email=setup@example.com",
    "commit",
    "-q",
    "-m",
    "Initial commit",
  );
  return directory;
}
