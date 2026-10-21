import { describe, expect, it } from "vitest";
import { condition, evaluate, interpolate } from "./support/expression.js";

const context = {
  github: { ref_name: "disclosure/frozen/7.0.x", sha: "abc" },
  env: { KIND: "active", HOTFIX: "true", EMPTY: "" },
  steps: {
    release: {
      outputs: { "release-version": "7.0.1", "due-date": "2026-11-19" },
    },
    train: { outputs: { found: "true" } },
  },
  needs: { plan: { outputs: { release: "true" } } },
  vars: {},
  __status: "success",
};

describe("the expressions of a workflow, as the local runner reads them", () => {
  it("reads contexts, with a name that has hyphens", () => {
    expect(evaluate("github.ref_name", context)).toBe(
      "disclosure/frozen/7.0.x",
    );
    expect(evaluate("steps.release.outputs.release-version", context)).toBe(
      "7.0.1",
    );
    expect(evaluate("steps.release.outputs['due-date']", context)).toBe(
      "2026-11-19",
    );
  });

  it("is null for what is not there, at any depth", () => {
    expect(evaluate("steps.nothing.outputs.x", context)).toBeNull();
    expect(evaluate("vars.RELEASE_TRAIN_REPOSITORY", context)).toBeNull();
  });

  it("looks up a property without regard to case, as GitHub does", () => {
    expect(evaluate("ENV.kind", context)).toBe("active");
  });

  it("compares strings without regard to case", () => {
    expect(evaluate("env.KIND == 'ACTIVE'", context)).toBe(true);
    expect(evaluate("env.KIND != 'frozen'", context)).toBe(true);
    expect(evaluate("steps.train.outputs.found == 'true'", context)).toBe(true);
  });

  it("takes null for an empty string", () => {
    expect(evaluate("vars.NOTHING == ''", context)).toBe(true);
    expect(evaluate("steps.train.outputs.nothing != 'true'", context)).toBe(
      true,
    );
  });

  it("gives an operand for && and ||, which is how a ternary is written", () => {
    expect(evaluate("env.KIND == 'active' && 'a' || 'b'", context)).toBe("a");
    expect(evaluate("env.KIND == 'frozen' && 'a' || 'b'", context)).toBe("b");
    expect(
      evaluate("env.KIND == 'active' && env.HOTFIX || github.sha", context),
    ).toBe("true");
    expect(evaluate("env.EMPTY || 'default'", context)).toBe("default");
  });

  it("negates, and has parentheses", () => {
    expect(evaluate("!(env.KIND == 'frozen')", context)).toBe(true);
    expect(
      evaluate("!env.EMPTY && (env.KIND == 'active' || false)", context),
    ).toBe(true);
  });

  it("calls the functions that the workflows use", () => {
    expect(evaluate("success()", context)).toBe(true);
    expect(evaluate("failure()", context)).toBe(false);
    expect(evaluate("always()", context)).toBe(true);
    expect(evaluate("fromJSON('{\"a\":[1,2]}').a[1]", context)).toBe(2);
    expect(evaluate("contains(github.ref_name, 'FROZEN')", context)).toBe(true);
    expect(
      evaluate("startsWith(github.ref_name, 'disclosure/')", context),
    ).toBe(true);
    expect(evaluate("endsWith(github.ref_name, '/main')", context)).toBe(false);
  });

  it("reads a quote in a string", () => {
    expect(evaluate("'it''s'", context)).toBe("it's");
  });

  it("says what it cannot read, and does not guess", () => {
    expect(() => evaluate("hashFiles('x')", context)).toThrow(
      "is not supported",
    );
    expect(() => evaluate("env.KIND ==", context)).toThrow();
    expect(() => evaluate("'open", context)).toThrow("not closed");
    expect(() => evaluate("a ? b : c", context)).toThrow();
  });
});

describe("interpolate", () => {
  it("replaces every expression of a text", () => {
    expect(
      interpolate(
        "release ${{ steps.release.outputs.release-version }} due ${{ steps.release.outputs.due-date }}",
        context,
      ),
    ).toBe("release 7.0.1 due 2026-11-19");
  });

  it("writes what is not there as nothing", () => {
    expect(interpolate("[${{ vars.NOTHING }}]", context)).toBe("[]");
  });

  it("leaves a text without an expression", () => {
    expect(interpolate("plain $HOME and ${HOME}", context)).toBe(
      "plain $HOME and ${HOME}",
    );
  });
});

describe("condition", () => {
  it("is true without a condition, while nothing has failed", () => {
    expect(condition(undefined, context)).toBe(true);
    expect(condition(undefined, { ...context, __status: "failure" })).toBe(
      false,
    );
  });

  it("takes success() && for a condition that has no status function", () => {
    expect(condition("steps.train.outputs.found == 'true'", context)).toBe(
      true,
    );
    expect(
      condition("steps.train.outputs.found == 'true'", {
        ...context,
        __status: "failure",
      }),
    ).toBe(false);
  });

  it("is left as it is with a status function", () => {
    expect(condition("always()", { ...context, __status: "failure" })).toBe(
      true,
    );
    expect(condition("failure()", { ...context, __status: "failure" })).toBe(
      true,
    );
    expect(condition("failure()", context)).toBe(false);
  });

  it("takes an expression with its ${{ }}", () => {
    expect(condition("${{ env.KIND == 'active' }}", context)).toBe(true);
  });
});
