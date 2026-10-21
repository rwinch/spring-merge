import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultMilestones = path.join(
  here,
  "..",
  "fixtures",
  "milestones.json",
);
export const defaultTrains = path.join(here, "..", "fixtures", "train");

/**
 * A small fake of the parts of the GitHub API that the actions use, for the tests and
 * for trying an action by hand (GITHUB_API_URL points an action to it):
 *
 *   GET  /repos/<owner>/<repo>                              the repository exists
 *   GET  /repos/<owner>/<repo>/milestones?state=&page=      the milestones
 *   GET  /repos/<owner>/<repo>/branches/<branch>            a branch of the trains
 *   GET  /repos/<owner>/<repo>/contents/<path>?ref=<branch> a file of a branch
 *   GET  /repos/<owner>/<repo>/issues?milestone=&state=     the issues (and pull requests)
 *   POST /repos/<owner>/<repo>/issues                       a new issue
 *
 * Every repository is the same: it has the milestones and the issues, and it has one
 * branch for every directory of `trains`, with the files of that directory. Only
 * `missing/missing` does not exist (404). The lists are paged with a Link header, like
 * GitHub does.
 *
 * It is a fake for one test or one try: the issues that are created are kept in `issues`
 * (and `createFailure`, if it is set to { status, message }, makes creating one fail).
 * `requests` records what it was asked, with the headers and the body.
 */
export async function startFakeGitHub({
  milestones,
  issues = [],
  trains = defaultTrains,
  port = 0,
} = {}) {
  const allMilestones =
    milestones ?? JSON.parse(fs.readFileSync(defaultMilestones, "utf8"));
  const requests = [];
  // `lag`: a new issue is not in the list for that many requests of the list, as on
  // GitHub, where it is there a few seconds after it is created.
  const fake = {
    issues: [...issues],
    requests,
    createFailure: undefined,
    lag: 0,
    listRequests: 0,
    hiddenUntil: new Map(),
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fake");
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: request.headers,
        body: text ? JSON.parse(text) : undefined,
      });
      handle(request, url, text ? JSON.parse(text) : undefined, response);
    });
  });

  function handle(request, url, body, response) {
    const send = (status, content, headers = {}) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        ...headers,
      });
      response.end(JSON.stringify(content));
    };
    const notFound = (message = "Not Found") => send(404, { message });
    // A page of a list, with the Link header to the next one: that is what Octokit follows.
    const page = (list) => {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const number = Number(url.searchParams.get("page") ?? 1);
      const headers = {};
      if (number * perPage < list.length) {
        const next = new URL(url);
        next.searchParams.set("page", String(number + 1));
        headers.Link = `<http://${request.headers.host}${next.pathname}${next.search}>; rel="next"`;
      }
      send(200, list.slice((number - 1) * perPage, number * perPage), headers);
    };

    const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!match || `${match[1]}/${match[2]}` === "missing/missing") {
      return notFound();
    }
    const [, owner, repo, rest = ""] = match;

    if (rest === "") {
      return send(200, { full_name: `${owner}/${repo}` });
    }

    if (rest === "/milestones" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      return page(
        allMilestones.filter((m) => state === "all" || m.state === state),
      );
    }

    if (rest === "/issues" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "open";
      const milestone = url.searchParams.get("milestone");
      // pages of one list count as one request: only the first page counts
      if ((url.searchParams.get("page") ?? "1") === "1") {
        fake.listRequests++;
      }
      return page(
        fake.issues.filter(
          (issue) =>
            fake.listRequests > (fake.hiddenUntil.get(issue.number) ?? 0) &&
            (state === "all" || issue.state === state) &&
            (milestone === null ||
              milestone === "*" ||
              String(issue.milestone?.number) === milestone),
        ),
      );
    }

    if (rest === "/issues" && request.method === "POST") {
      if (fake.createFailure) {
        return send(fake.createFailure.status, {
          message: fake.createFailure.message,
        });
      }
      const milestone = allMilestones.find((m) => m.number === body?.milestone);
      if (!body?.title) {
        return send(422, { message: "Validation Failed: title is missing" });
      }
      if (body.milestone !== undefined && !milestone) {
        return send(422, {
          message: "Validation Failed: milestone is invalid",
        });
      }
      const number =
        Math.max(0, ...fake.issues.map((issue) => issue.number)) + 1;
      const issue = {
        number,
        title: body.title,
        body: body.body ?? null,
        state: "open",
        milestone: milestone
          ? { number: milestone.number, title: milestone.title }
          : null,
        labels: (body.labels ?? []).map((name) => ({ name })),
        type: body.type ? { name: body.type } : null,
      };
      fake.issues.push(issue);
      if (fake.lag > 0) {
        fake.hiddenUntil.set(number, fake.listRequests + fake.lag);
      }
      return send(201, issue);
    }

    const branch = rest.match(/^\/branches\/(.+)$/);
    if (branch) {
      const name = decodeURIComponent(branch[1]);
      return isBranch(trains, name)
        ? send(200, { name })
        : notFound("Branch not found");
    }

    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents) {
      const file = decodeURIComponent(contents[1]);
      const ref = url.searchParams.get("ref");
      const found = ref && isBranch(trains, ref) && readFile(trains, ref, file);
      if (found === undefined || found === false || found === null) {
        return notFound();
      }
      return send(200, {
        type: "file",
        name: path.basename(file),
        path: file,
        encoding: "base64",
        content: Buffer.from(found).toString("base64"),
      });
    }

    return notFound();
  }

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((resolve) => server.close(resolve));
  return fake;
}

function isBranch(trains, name) {
  return (
    !name.includes("/") &&
    !name.includes("..") &&
    fs.existsSync(path.join(trains, name)) &&
    fs.statSync(path.join(trains, name)).isDirectory()
  );
}

function readFile(trains, branch, file) {
  if (file.includes("..")) {
    return undefined;
  }
  const full = path.join(trains, branch, file);
  return fs.existsSync(full) && fs.statSync(full).isFile()
    ? fs.readFileSync(full)
    : undefined;
}

// Run by hand: node test/support/fake-github.js [port] [milestones.json] [trains directory]
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.argv[2] ?? 8123);
  const file = process.argv[3] ?? defaultMilestones;
  const trains = process.argv[4] ?? defaultTrains;
  const fake = await startFakeGitHub({
    port,
    trains,
    milestones: JSON.parse(fs.readFileSync(file, "utf8")),
  });
  console.log(
    `The fake GitHub is at ${fake.url}, serving the milestones of ${file} and the branches of ${trains}`,
  );
}
