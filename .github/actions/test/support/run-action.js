import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOutputFile } from "./outputs.js";

export const actionsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * Runs an action the way GitHub does, as a program: its inputs are INPUT_<NAME>
 * variables, and its outputs are written to the file named by GITHUB_OUTPUT. It
 * resolves with the outputs, the exit code and what the action printed, and never
 * rejects because the action failed.
 */
export async function runAction(entry, inputs, env = {}) {
  const outputFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "action-")),
    "output",
  );
  // GitHub creates the file of outputs before it runs an action, and @actions/core fails
  // if it is not there.
  fs.writeFileSync(outputFile, "");
  const inputEnv = Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      `INPUT_${name.toUpperCase()}`,
      value,
    ]),
  );
  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(actionsDir, entry)],
      {
        env: {
          PATH: process.env.PATH,
          ...inputEnv,
          GITHUB_OUTPUT: outputFile,
          ...env,
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
  return { ...result, outputs: parseOutputFile(outputFile) };
}
