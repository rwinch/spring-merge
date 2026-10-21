import { execFileSync } from "node:child_process";

/**
 * Runs git in a directory and returns what it printed, without the last newline. If it
 * fails, the error is what git said, with the command, instead of a stack trace.
 */
export function git(directory, ...args) {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\n$/, "");
  } catch (error) {
    const said = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${said || error.message}`);
  }
}

/**
 * Fails, with what to do, if git has not been told who commits (user.name and
 * user.email, or the GIT_AUTHOR_* and GIT_COMMITTER_* variables). Without this, git
 * makes an identity up from the name of the user and of the machine, for example
 * runner@fv-az123, and the commits are made as that.
 */
export function requireIdentity(directory) {
  try {
    git(
      directory,
      "-c",
      "user.useConfigOnly=true",
      "var",
      "GIT_COMMITTER_IDENT",
    );
    git(directory, "-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT");
  } catch {
    throw new Error(
      "git does not know who commits: set user.name and user.email (git config), for example to github-actions[bot] and 41898282+github-actions[bot]@users.noreply.github.com",
    );
  }
}
