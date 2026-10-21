import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { condition, evaluate, interpolate, stringify } from "./expression.js";
import { parseOutputFile } from "./outputs.js";

/**
 * Runs a GitHub workflow on this machine, for the tests: the workflow file itself, so
 * that what it does with the actions, the scripts and git can be tried with no GitHub
 * and no Docker (act needs both). It is not GitHub, and does what the workflows of this
 * project need of it:
 *
 *  - jobs, in the order of `needs`, each in a fresh checkout, with their outputs, and a job
 *    that is skipped if its `if` is false or a job that it needs did not succeed
 *  - steps in order, with `id`, `if`, `env`, `with`, `run` and `uses`, the outputs that
 *    they write to GITHUB_OUTPUT, and the expressions ${{ }} (see expression.js)
 *  - `run` with bash -eo pipefail, as GitHub does, and the actions of the project
 *    (`uses: ./.github/actions/<name>`) run as the programs that they are, from the
 *    checkout, with their inputs as INPUT_<NAME> and the defaults of their action.yml
 *  - actions/checkout does nothing, because the checkout is made for the job, nor does
 *    actions/setup-java, which leaves the Java of this machine, and the action
 *    compute-version of spring-release-actions is done here the way it does it
 *
 * Anything else that a workflow uses fails with a message, and is a sign that the runner
 * is to learn it. The git of the developer is kept out of it: no global configuration
 * (a signing key that needs a password, for example), only what the workflow sets.
 */
export async function runWorkflow({
  workflowFile,
  checkout,
  github,
  secrets = {},
  vars = {},
  env = {},
}) {
  const workflow = parse(fs.readFileSync(workflowFile, "utf8"));
  const results = {};
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-"));
  const log = [];

  for (const jobId of order(workflow.jobs)) {
    const job = workflow.jobs[jobId];
    const needs = [].concat(job.needs ?? []);
    const context = {
      github,
      secrets,
      vars,
      runner: { temp },
      needs: Object.fromEntries(
        needs.map((n) => [
          n,
          { result: results[n].result, outputs: results[n].outputs },
        ]),
      ),
      steps: {},
      env: {},
      job: { status: "success" },
      __status: needs.every((n) => results[n].result === "success")
        ? "success"
        : "failure",
    };
    context.env = evaluateAll(workflow.env, context);

    if (!condition(job.if, context)) {
      results[jobId] = { result: "skipped", outputs: {}, steps: [] };
      log.push(`[${jobId}] skipped`);
      continue;
    }

    context.__status = "success";
    context.env = { ...context.env, ...evaluateAll(job.env, context) };
    const workspace = await checkout(jobId);
    const summary = path.join(temp, `${jobId}-summary.md`);
    fs.writeFileSync(summary, "");
    const steps = [];

    for (const [index, step] of (job.steps ?? []).entries()) {
      const name = step.name ?? step.uses ?? `step ${index + 1}`;
      if (!condition(step.if, context)) {
        steps.push({
          name,
          id: step.id,
          outcome: "skipped",
          output: "",
          outputs: {},
        });
        if (step.id) {
          context.steps[step.id] = {
            outcome: "skipped",
            conclusion: "skipped",
            outputs: {},
          };
        }
        continue;
      }
      const stepEnv = { ...context.env, ...evaluateAll(step.env, context) };
      const stepContext = { ...context, env: stepEnv };
      const outputFile = path.join(temp, `${jobId}-${index}-output`);
      fs.writeFileSync(outputFile, "");
      const processEnv = {
        PATH: process.env.PATH,
        HOME: temp,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        CI: "true",
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: github.event_name ?? "push",
        GITHUB_WORKSPACE: workspace,
        GITHUB_REPOSITORY: github.repository,
        GITHUB_REPOSITORY_OWNER: github.repository_owner,
        GITHUB_REF: github.ref,
        GITHUB_REF_NAME: github.ref_name,
        GITHUB_SHA: github.sha,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summary,
        RUNNER_TEMP: temp,
        ...env,
        ...stringValues(stepEnv),
      };

      let outcome;
      try {
        outcome = await runStep(step, stepContext, workspace, processEnv);
      } catch (error) {
        outcome = { code: 1, output: `::error::${error.message}\n` };
      }
      const outputs = parseOutputFile(outputFile);
      const result = outcome.code === 0 ? "success" : "failure";
      steps.push({
        name,
        id: step.id,
        outcome: result,
        output: outcome.output,
        outputs,
      });
      if (step.id) {
        context.steps[step.id] = {
          outcome: result,
          conclusion: result,
          outputs,
        };
      }
      log.push(`[${jobId}] ${name}: ${result}`);
      if (result === "failure") {
        context.__status = "failure";
        context.job.status = "failure";
      }
    }

    const succeeded = context.__status === "success";
    results[jobId] = {
      result: succeeded ? "success" : "failure",
      outputs: Object.fromEntries(
        Object.entries(job.outputs ?? {}).map(([name, value]) => [
          name,
          interpolate(value, context),
        ]),
      ),
      steps,
      workspace,
      summary: fs.readFileSync(summary, "utf8"),
    };
  }

  return {
    ok: Object.values(results).every((r) => r.result !== "failure"),
    jobs: results,
    log,
    /** The step with that name, of any job. */
    step(name) {
      return Object.values(results)
        .flatMap((r) => r.steps)
        .find((s) => s.name === name);
    },
  };
}

// The jobs in an order in which each comes after the ones that it needs.
function order(jobs) {
  const done = [];
  const visit = (id) => {
    if (done.includes(id)) {
      return;
    }
    for (const need of [].concat(jobs[id].needs ?? [])) {
      visit(need);
    }
    done.push(id);
  };
  Object.keys(jobs).forEach(visit);
  return done;
}

function evaluateAll(values, context) {
  return Object.fromEntries(
    Object.entries(values ?? {}).map(([name, value]) => [
      name,
      interpolate(
        typeof value === "string" ? value : stringify(value),
        context,
      ),
    ]),
  );
}

const stringValues = (values) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));

function exec(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) =>
      resolve({ code: 127, output: `${error.message}\n` }),
    );
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function runStep(step, context, workspace, processEnv) {
  if (step.run !== undefined) {
    const script = path.join(
      path.dirname(processEnv.GITHUB_OUTPUT),
      `${path.basename(processEnv.GITHUB_OUTPUT)}.sh`,
    );
    fs.writeFileSync(script, interpolate(step.run, context));
    return exec("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: workspace,
      env: processEnv,
    });
  }

  const uses = step.uses;
  if (uses?.startsWith("actions/checkout@")) {
    return { code: 0, output: "checked out already\n" };
  }
  if (uses?.startsWith("actions/setup-java@")) {
    // The Java of this machine is the one that is used
    return { code: 0, output: "using the Java of this machine\n" };
  }
  if (uses?.startsWith("spring-io/spring-release-actions/compute-version@")) {
    // What the action does for a Gradle project: the version of gradle.properties
    const properties = fs.readFileSync(
      path.join(workspace, "gradle.properties"),
      "utf8",
    );
    const version = /^version=(.*)$/m.exec(properties)?.[1] ?? "";
    fs.appendFileSync(
      processEnv.GITHUB_OUTPUT,
      `version=${version}\nsnapshot=${version.endsWith("-SNAPSHOT")}\n`,
    );
    return { code: 0, output: `The version is ${version}\n` };
  }
  if (uses?.startsWith("./")) {
    const directory = path.join(workspace, uses);
    const action = parse(
      fs.readFileSync(path.join(directory, "action.yml"), "utf8"),
    );
    const given = evaluateAll(step.with, context);
    const inputEnv = {};
    for (const [name, definition] of Object.entries(action.inputs ?? {})) {
      const value = given[name] ?? definition.default;
      if (value !== undefined) {
        inputEnv[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] =
          String(value);
      }
    }
    for (const name of Object.keys(given)) {
      if (!(name in (action.inputs ?? {}))) {
        throw new Error(`${uses} has no input ${name}`);
      }
    }
    return exec(process.execPath, [path.resolve(directory, action.runs.main)], {
      cwd: workspace,
      env: { ...processEnv, ...inputEnv },
    });
  }
  throw new Error(`The local runner does not know ${uses ?? "this step"}`);
}

export { evaluate };
