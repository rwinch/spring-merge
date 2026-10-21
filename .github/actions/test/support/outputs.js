import fs from "node:fs";

/**
 * The outputs that an action or a step wrote to the file named by GITHUB_OUTPUT, in the
 * two forms that GitHub reads:
 *
 *   name=value
 *   name<<DELIMITER
 *   value (maybe of more lines)
 *   DELIMITER
 *
 * It is {} if there is no such file.
 */
export function parseOutputFile(file) {
  if (!fs.existsSync(file)) {
    return {};
  }
  const outputs = {};
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heredoc = lines[i].match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], i + 1);
      outputs[heredoc[1]] = lines.slice(i + 1, end).join("\n");
      i = end;
      continue;
    }
    const plain = lines[i].match(/^([^=]+)=(.*)$/);
    if (plain) {
      outputs[plain[1]] = plain[2];
    }
  }
  return outputs;
}
