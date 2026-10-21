// The expressions of a GitHub workflow, ${{ ... }}, as far as the workflows of this
// project use them. It is for run-workflow.js, which runs a workflow locally.
//
//   literals       'text' ('' is a quote), 12, true, false, null
//   contexts       github.ref_name, steps.release.outputs['due-date'], env.KIND
//   operators      !  ==  !=  &&  ||  and parentheses
//   functions      success() failure() always() cancelled() fromJSON() toJSON()
//                  contains() startsWith() endsWith()
//
// as GitHub evaluates them: == compares strings without regard to case, && and || give
// one of their operands, and '', 0, false and null are false.

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= source.length) {
          throw new Error(`A string is not closed in: ${source}`);
        }
        if (source[j] === "'") {
          if (source[j + 1] === "'") {
            text += "'";
            j += 2;
            continue;
          }
          break;
        }
        text += source[j++];
      }
      tokens.push({ type: "string", value: text });
      i = j + 1;
    } else if (["==", "!=", "&&", "||"].includes(source.slice(i, i + 2))) {
      tokens.push({ type: "op", value: source.slice(i, i + 2) });
      i += 2;
    } else if ("!.[](),".includes(c)) {
      tokens.push({ type: "op", value: c });
      i++;
    } else {
      const number = /^\d+(\.\d+)?/.exec(source.slice(i));
      const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i));
      if (number) {
        tokens.push({ type: "number", value: Number(number[0]) });
        i += number[0].length;
      } else if (name) {
        tokens.push({ type: "name", value: name[0] });
        i += name[0].length;
      } else {
        throw new Error(`Unexpected "${c}" in: ${source}`);
      }
    }
  }
  return tokens;
}

function parse(source) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const take = (value) => {
    const token = tokens[position];
    if (value !== undefined && (!token || token.value !== value)) {
      throw new Error(`Expected ${value} in: ${source}`);
    }
    position++;
    return token;
  };
  const isOp = (value) => peek()?.type === "op" && peek().value === value;

  function parseOr() {
    let left = parseAnd();
    while (isOp("||")) {
      take();
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    let left = parseEquality();
    while (isOp("&&")) {
      take();
      left = { type: "and", left, right: parseEquality() };
    }
    return left;
  }
  function parseEquality() {
    let left = parseUnary();
    while (isOp("==") || isOp("!=")) {
      const operator = take().value;
      left = {
        type: "equals",
        negate: operator === "!=",
        left,
        right: parseUnary(),
      };
    }
    return left;
  }
  function parseUnary() {
    if (isOp("!")) {
      take();
      return { type: "not", operand: parseUnary() };
    }
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parsePrimary();
    for (;;) {
      if (isOp(".")) {
        take();
        node = { type: "property", object: node, name: take().value };
      } else if (isOp("[")) {
        take();
        const key = parseOr();
        take("]");
        node = { type: "index", object: node, key };
      } else {
        return node;
      }
    }
  }
  function parsePrimary() {
    const token = take();
    if (!token) {
      throw new Error(`The expression ends too soon: ${source}`);
    }
    if (token.type === "string" || token.type === "number") {
      return { type: "literal", value: token.value };
    }
    if (token.type === "op" && token.value === "(") {
      const inner = parseOr();
      take(")");
      return inner;
    }
    if (token.type === "name") {
      if (["true", "false", "null"].includes(token.value)) {
        return {
          type: "literal",
          value: { true: true, false: false, null: null }[token.value],
        };
      }
      if (isOp("(")) {
        take();
        const args = [];
        while (!isOp(")")) {
          args.push(parseOr());
          if (isOp(",")) {
            take();
          }
        }
        take(")");
        return { type: "call", name: token.value, args };
      }
      return { type: "root", name: token.value };
    }
    throw new Error(`Unexpected ${token.value} in: ${source}`);
  }

  const tree = parseOr();
  if (position !== tokens.length) {
    throw new Error(`Unexpected ${tokens[position].value} in: ${source}`);
  }
  return tree;
}

// GitHub looks up a property without regard to case.
function get(object, name) {
  if (object === null || object === undefined || typeof object !== "object") {
    return null;
  }
  if (Object.hasOwn(object, name)) {
    return object[name] ?? null;
  }
  const key = Object.keys(object).find(
    (k) => k.toLowerCase() === String(name).toLowerCase(),
  );
  return key === undefined ? null : (object[key] ?? null);
}

const truthy = (value) =>
  !(
    value === false ||
    value === 0 ||
    value === "" ||
    value === null ||
    value === undefined
  );

const toNumber = (value) =>
  value === null || value === ""
    ? 0
    : value === true
      ? 1
      : value === false
        ? 0
        : Number(value);

function equals(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (typeof a === typeof b && typeof a !== "object") {
    return a === b;
  }
  return toNumber(a) === toNumber(b);
}

export function stringify(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function evaluateNode(node, context) {
  switch (node.type) {
    case "literal":
      return node.value;
    case "root":
      return get(context, node.name);
    case "property":
      return get(evaluateNode(node.object, context), node.name);
    case "index":
      return get(
        evaluateNode(node.object, context),
        stringify(evaluateNode(node.key, context)),
      );
    case "not":
      return !truthy(evaluateNode(node.operand, context));
    case "and": {
      const left = evaluateNode(node.left, context);
      return truthy(left) ? evaluateNode(node.right, context) : left;
    }
    case "or": {
      const left = evaluateNode(node.left, context);
      return truthy(left) ? left : evaluateNode(node.right, context);
    }
    case "equals": {
      const same = equals(
        evaluateNode(node.left, context),
        evaluateNode(node.right, context),
      );
      return node.negate ? !same : same;
    }
    case "call": {
      const args = node.args.map((arg) => evaluateNode(arg, context));
      const status = context.__status ?? "success";
      switch (node.name.toLowerCase()) {
        case "success":
          return status === "success";
        case "failure":
          return status === "failure";
        case "always":
          return true;
        case "cancelled":
          return false;
        case "fromjson":
          return JSON.parse(stringify(args[0]));
        case "tojson":
          return JSON.stringify(args[0], null, 2);
        case "contains":
          return stringify(args[0])
            .toLowerCase()
            .includes(stringify(args[1]).toLowerCase());
        case "startswith":
          return stringify(args[0])
            .toLowerCase()
            .startsWith(stringify(args[1]).toLowerCase());
        case "endswith":
          return stringify(args[0])
            .toLowerCase()
            .endsWith(stringify(args[1]).toLowerCase());
        default:
          throw new Error(
            `The function ${node.name} is not supported by the local runner`,
          );
      }
    }
    default:
      throw new Error(`Unknown node ${node.type}`);
  }
}

/** The value of an expression, without the ${{ }}. */
export function evaluate(expression, context) {
  return evaluateNode(parse(expression), context);
}

/** A text with its ${{ }} expressions replaced by their values, as text. */
export function interpolate(text, context) {
  if (typeof text !== "string") {
    return text;
  }
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
    stringify(evaluate(expression, context)),
  );
}

/**
 * The condition of a job or a step. Without a status function in it, GitHub takes it as
 * success() && (condition), so a step does not run after one has failed.
 */
export function condition(text, context) {
  if (text === undefined || text === null) {
    return (context.__status ?? "success") === "success";
  }
  const expression = String(text).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, "$1");
  const hasStatus = /\b(success|failure|always|cancelled)\s*\(/i.test(
    expression,
  );
  const value = truthy(evaluate(expression, context));
  return hasStatus
    ? value
    : (context.__status ?? "success") === "success" && value;
}
