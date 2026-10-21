// Bundles every action (src/<name>/index.js, except src/lib) into dist/<name>/ with ncc,
// because GitHub runs the committed dist/, with no npm install.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const src = path.join(root, "src");
const ncc = path.join(root, "node_modules", ".bin", "ncc");

for (const name of fs.readdirSync(src).sort()) {
  const entry = path.join(src, name, "index.js");
  if (name === "lib" || !fs.existsSync(entry)) {
    continue;
  }
  execFileSync(
    ncc,
    [
      "build",
      entry,
      "--out",
      path.join(root, "dist", name),
      "--no-source-map-register",
    ],
    { stdio: "inherit", cwd: root },
  );
}
