import fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as core from "@actions/core";

/**
 * Whether the module with the given import.meta.url is the program being run,
 * as in `node src/<action>/index.js`, and not imported by a test. The path of the
 * program is resolved first: Node reports the real path of the main module, so a
 * path through a symbolic link (/tmp on macOS) would never match otherwise.
 */
export function isMain(metaUrl) {
  const program = process.argv[1];
  if (!program) {
    return false;
  }
  return metaUrl === pathToFileURL(fs.realpathSync(program)).href;
}

/**
 * Runs an action, and reports an error the way GitHub shows it (and sets a failing
 * exit code), instead of printing a stack trace.
 */
export async function execute(action) {
  try {
    await action();
  } catch (error) {
    core.setFailed(error.message);
  }
}
