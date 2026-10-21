// The [versions] section of a Gradle version catalog (gradle/libs.versions.toml). Only
// the lines of the form `name = "value"` are read and changed: that is the form the
// release automation relies on, one version on one line.

const SECTION = /^\s*\[([^\]]+)\]\s*$/;
const VERSION = /^([A-Za-z0-9_.-]+)(\s*=\s*)"([^"]*)"(\s*)$/;

/**
 * The versions of the [versions] section, as a Map from the name to the value, in the
 * order of the file.
 */
export function readVersions(text) {
  const versions = new Map();
  let inVersions = false;
  for (const line of text.split(/\r?\n/)) {
    const section = SECTION.exec(line);
    if (section) {
      inVersions = section[1].trim() === "versions";
      continue;
    }
    const version = inVersions ? VERSION.exec(line) : null;
    if (version) {
      versions.set(version[1], version[3]);
    }
  }
  return versions;
}

/**
 * The text of the catalog with the version of the [versions] section changed, and
 * everything else the way it was: the other lines, the comments, the spaces around the
 * equals sign, and the line endings. It fails if there is no such version, so that a
 * name that is wrong is not ignored.
 */
export function setVersion(text, name, value) {
  if (!/^[A-Za-z0-9._+-]+$/.test(value ?? "")) {
    throw new Error(
      `"${value}" is not a version to write in a version catalog: expected letters, digits, dots, hyphens and plus signs`,
    );
  }
  const lines = text.split(/(\r?\n)/); // the line endings are kept, at the odd positions
  let inVersions = false;
  for (let i = 0; i < lines.length; i += 2) {
    const section = SECTION.exec(lines[i]);
    if (section) {
      inVersions = section[1].trim() === "versions";
      continue;
    }
    const version = inVersions ? VERSION.exec(lines[i]) : null;
    if (version && version[1] === name) {
      lines[i] = `${version[1]}${version[2]}"${value}"${version[4]}`;
      return lines.join("");
    }
  }
  throw new Error(
    `The version catalog has no version ${name} (a line of the form ${name} = "..." in its [versions] section)`,
  );
}
