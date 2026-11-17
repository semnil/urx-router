const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const workflowPath = path.resolve(__dirname, "../workflows/issue-auto-assign.yml");
const workflow = JSON.parse(execFileSync("yq", ["-o=json", ".", workflowPath], { encoding: "utf8" }));
const script = workflow.jobs.assign.steps[0].run;
const entryPoints = {
  MixTrack2Source: 6,
  "analyze-loudness": 2,
  "analyze-spectrum": 2,
  "audio-interface-compare-site": 8,
  "jimaku-translator": 3,
  "notification-sound-db": 1,
  "twitch-channel-volume": 1,
  "urx-lcd-sim": 1,
  "urx-router": 7,
  "x-to-bsky": 3,
  "yt-channel-volume": 2,
};

function run({
  repository = "semnil/MixTrack2Source",
  number = 1000,
  action = "opened",
  eventName = "issues",
  assignees = [],
  pullRequest = false,
  failure = false,
  omitAssignment = false,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "issue-auto-assign-"));
  try {
    const event = { action, issue: { number, assignees: assignees.map((login) => ({ login })) } };
    if (pullRequest) event.issue.pull_request = {};
    fs.writeFileSync(path.join(directory, "event.json"), JSON.stringify(event));
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify(assignees));
    fs.writeFileSync(
      path.join(directory, "gh"),
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.TEST_DIRECTORY;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(directory, 'calls.jsonl'), JSON.stringify(args) + '\\n');
require('node:assert/strict').deepEqual(args, [
  'api', '--method', 'POST', process.env.EXPECTED_ENDPOINT, '-f', 'assignees[]=semnil'
]);
if (process.env.TEST_FAILURE === '1') process.exit(1);
const state = JSON.parse(fs.readFileSync(path.join(directory, 'state.json')));
if (process.env.TEST_OMIT_ASSIGNMENT !== '1' && !state.includes('semnil')) state.push('semnil');
fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state));
console.log(JSON.stringify({ assignees: state.map(login => ({ login })) }));
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env.PATH}`,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_REPOSITORY: repository,
        GITHUB_EVENT_PATH: path.join(directory, "event.json"),
        GH_TOKEN: "test-token",
        TEST_DIRECTORY: directory,
        EXPECTED_ENDPOINT: `repos/${repository}/issues/${number}/assignees`,
        TEST_FAILURE: failure ? "1" : "0",
        TEST_OMIT_ASSIGNMENT: omitAssignment ? "1" : "0",
      },
    });
    assert.ifError(result.error);
    const callsPath = path.join(directory, "calls.jsonl");
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse) : [];
    return { ...result, calls, assignees: JSON.parse(fs.readFileSync(path.join(directory, "state.json"))) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("only issue creation can write; every pull request tests with a read-only token", () => {
  assert.deepEqual(workflow.on, { issues: { types: ["opened"] }, pull_request: null });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.jobs.assign.if, "github.event_name == 'issues' && github.repository_owner == 'semnil'");
  assert.deepEqual(workflow.jobs.assign.permissions, { issues: "write" });
  assert.equal(workflow.jobs.assign.steps.length, 1);
  assert.equal(workflow.jobs.test.name, "Issue auto-assignment tests");
  assert.equal(workflow.jobs.test.if, "github.event_name == 'pull_request'");
  assert.deepEqual(workflow.jobs.test.permissions, { contents: "read" });
  assert.equal(workflow.jobs.test.steps[0].with["persist-credentials"], false);
  assert.equal(workflow.jobs.test.steps.at(-1).run, "node --test .github/tests/issue-auto-assign.test.cjs");
  for (const job of Object.values(workflow.jobs)) assert.ok(job["timeout-minutes"] > 0);
  assert.ok(!script.includes("${{"), "issue content is never interpolated into shell code");
});

for (const [name, number] of Object.entries(entryPoints)) {
  test(`${name}: a new inquiry adds semnil and preserves another assignee`, () => {
    for (const assignees of [[], ["another-maintainer"]]) {
      const result = run({ repository: `semnil/${name}`, assignees });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.calls.length, 1);
      assert.deepEqual(result.assignees, [...assignees, "semnil"]);
    }
  });
  test(`${name}: the permanent feedback issue makes no API call`, () => {
    const result = run({ repository: `semnil/${name}`, number });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.assignees, []);
  });
}

for (const action of ["edited", "reopened", "closed", "unassigned", "assigned"]) {
  test(`${action} does not assign an existing issue`, () => {
    const result = run({ action });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  });
}

test("pull requests cannot reach the assignment API", () => {
  for (const options of [{ eventName: "pull_request" }, { pullRequest: true }]) {
    const result = run(options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
  }
});

test("an already assigned inquiry does not duplicate or remove assignees", () => {
  const result = run({ assignees: ["another-maintainer", "semnil"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.assignees, ["another-maintainer", "semnil"]);
});

test("API failures and success responses missing semnil fail the job", () => {
  for (const options of [{ failure: true }, { omitAssignment: true }]) {
    const result = run(options);
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
  }
});

test("invalid issue numbers fail without making an API call", () => {
  for (const number of [null, 0, -1, 1.5, "1000"]) {
    const result = run({ number });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  }
});
