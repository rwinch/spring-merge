import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@actions/core";
import { git, requireIdentity } from "../lib/git.js";
import { execute, isMain } from "../lib/run.js";

export const BROADCOM_COPYRIGHT =
  " * Copyright 2004 Broadcom Inc. and/or its subsidiaries. All Rights Reserved.";

// The commercial license, which is bundled with the action: it is the file LICENSE.txt
// next to action.yml. The program is in src/apply-commercial-license/ or in
// dist/apply-commercial-license/, the same depth, so it is found from both.
export const BUNDLED_LICENSE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apply-commercial-license",
  "LICENSE.txt",
);

/**
 * The text of a Java file with its Apache license header replaced by the Broadcom one:
 * a Broadcom copyright line first, then the copyright lines that the header had, as they
 * were, and the license text left out.
 *
 *   /*
 *    * Copyright 2004 Broadcom Inc. and/or its subsidiaries. All Rights Reserved.
 *    * Copyright 2002-2026 the original author or authors.
 *    *\/
 *
 * Only the comment at the very start of the file is looked at, and only if it says that
 * it is licensed under the Apache License. A file that has another header, or the
 * Broadcom one already, is returned as it is, so it is safe to do more than once. The
 * line endings of the file are kept.
 */
export function replaceHeader(text) {
  const header = /^\/\*([\s\S]*?)\*\//.exec(text);
  if (!header || !header[1].includes("Licensed under the Apache License")) {
    return text;
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const copyrights = header[1]
    .split(/\r?\n/)
    .filter((line) => /^\s*\*\s*Copyright /.test(line));
  const replacement = ["/*", BROADCOM_COPYRIGHT, ...copyrights, " */"].join(
    eol,
  );
  return replacement + text.slice(header[0].length);
}

/**
 * Changes the files of a git repository to the commercial ones, which is only done for a
 * hotfix: the license header of every Java file, and the license of the project
 * (LICENSE.txt). It returns what it changed. If it is given a message, it commits that,
 * signed off, as the identity that git is set up with.
 */
export function applyCommercialLicense({
  directory,
  licenseFile = BUNDLED_LICENSE,
  commitMessage = "",
  log = () => {},
}) {
  if (!fs.existsSync(licenseFile)) {
    throw new Error(`The license does not exist: ${licenseFile}`);
  }
  const changed = [];
  const javaFiles = git(directory, "ls-files", "-z", "--", "*.java")
    .split("\0")
    .filter(Boolean);
  for (const file of javaFiles) {
    const full = path.join(directory, file);
    const text = fs.readFileSync(full, "utf8");
    const replaced = replaceHeader(text);
    if (replaced !== text) {
      fs.writeFileSync(full, replaced);
      changed.push(file);
      log(`${file}: the Broadcom header`);
    }
  }
  const java = changed.length;

  const target = path.join(directory, "LICENSE.txt");
  const license = fs.readFileSync(licenseFile);
  const had = fs.existsSync(target);
  if (!had || !fs.readFileSync(target).equals(license)) {
    fs.writeFileSync(target, license);
    changed.push("LICENSE.txt");
    log(`LICENSE.txt: the commercial license${had ? "" : " (it had none)"}`);
  }

  let commit = "";
  if (commitMessage && changed.length > 0) {
    requireIdentity(directory);
    git(directory, "add", "--", ...changed);
    git(
      directory,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--signoff",
      "--message",
      commitMessage,
      "--",
      ...changed,
    );
    commit = git(directory, "rev-parse", "HEAD");
    log(`Committed ${commit.slice(0, 7)}: ${commitMessage}`);
  }
  return { changed, java, license: changed.includes("LICENSE.txt"), commit };
}

export async function main() {
  const result = applyCommercialLicense({
    directory: core.getInput("path") || ".",
    licenseFile: core.getInput("license-file") || BUNDLED_LICENSE,
    commitMessage: core.getInput("commit-message"),
    log: (line) => core.info(line),
  });
  core.info(
    `${result.java} Java files and ${result.license ? "the license" : "no license"} changed`,
  );
  core.setOutput("java-files", String(result.java));
  core.setOutput("license", String(result.license));
  core.setOutput("changed", JSON.stringify(result.changed));
  core.setOutput("commit", result.commit);
}

if (isMain(import.meta.url)) {
  execute(main);
}
