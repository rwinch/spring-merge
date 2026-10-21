/**
 * Reads a boolean input. An input that was not given (as when an action runs locally,
 * where the defaults of action.yml do not apply) has the fallback.
 */
export function parseBoolean(name, value, fallback) {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "") {
    return fallback;
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  throw new Error(`The input ${name} must be true or false, not "${value}"`);
}
