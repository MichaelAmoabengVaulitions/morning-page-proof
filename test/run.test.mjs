import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODEL } from "../src/config.mjs";
import { readExport, readOptions, sendToOpenRouter } from "../src/run.mjs";

const FAKE_KEY = "fake-key-for-tests";
const REQUEST = { model: "test/model", messages: [] };
const GOOD_REPLY = {
  status: 200,
  body: { choices: [{ message: { content: "Send the plan to Ana." } }], usage: { cost: 0.0002 } },
};

function fakeFetch(answers) {
  const calls = [];
  async function fetchFn(url, options) {
    const answer = answers[calls.length];
    calls.push({ url, options });
    if (answer instanceof Error) throw answer;
    const body = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(body, { status: answer.status });
  }
  return { fetchFn, calls };
}

async function send(answers) {
  const { fetchFn, calls } = fakeFetch(answers);
  const result = await sendToOpenRouter(REQUEST, FAKE_KEY, fetchFn);
  return { result, callCount: calls.length, calls };
}

describe("calling OpenRouter", () => {
  it("returns the reply and cost, and sends the key only in the header", async () => {
    const { result, calls } = await send([GOOD_REPLY]);
    assert.equal(result.text, "Send the plan to Ana.");
    assert.equal(result.cost, 0.0002);
    assert.equal(calls[0].options.headers.Authorization, `Bearer ${FAKE_KEY}`);
    assert.ok(!calls[0].options.body.includes(FAKE_KEY));
  });

  it("doesn't retry a 401 or 403, and says the key was rejected without showing it", async () => {
    for (const status of [401, 403]) {
      const { result, callCount } = await send([{ status, body: {} }, GOOD_REPLY]);
      assert.equal(callCount, 1);
      assert.equal(result.keyRejected, true);
      assert.match(result.error, /key was rejected/);
      assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
    }
  });

  it("retries a 429, a 5xx or a timeout once", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    for (const firstAnswer of [{ status: 429, body: {} }, { status: 503, body: {} }, timeout]) {
      const { result, callCount } = await send([firstAnswer, GOOD_REPLY]);
      assert.equal(callCount, 2);
      assert.equal(result.text, "Send the plan to Ana.");
    }
  });

  it("gives up after one retry, and doesn't retry other errors", async () => {
    const twoFailures = await send([{ status: 500, body: {} }, { status: 500, body: {} }, GOOD_REPLY]);
    assert.equal(twoFailures.callCount, 2);
    assert.match(twoFailures.result.error, /500/);
    const badRequest = await send([{ status: 400, body: {} }, GOOD_REPLY]);
    assert.equal(badRequest.callCount, 1);
  });

  it("never copies a network error message, which could hold the key", async () => {
    const networkError = new Error(`request failed, headers: Authorization: Bearer ${FAKE_KEY}`);
    const { result } = await send([networkError, networkError]);
    assert.match(result.error, /couldn't reach OpenRouter/);
    assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
  });

  it("fails clearly on a reply that isn't JSON or has no choices", async () => {
    assert.match((await send([{ status: 200, body: "not json" }])).result.error, /valid JSON/);
    assert.match((await send([{ status: 200, body: { usage: {} } }])).result.error, /no choices/);
  });

  it("reports a missing cost as null, not zero", async () => {
    const { result } = await send([{ status: 200, body: { choices: [{ message: { content: "Send it." } }] } }]);
    assert.equal(result.cost, null);
  });
});

describe("reading the command line", () => {
  it("reads --dry-run and --model, with a default model", () => {
    assert.deepEqual(readOptions([]), { dryRun: false, model: DEFAULT_MODEL });
    assert.deepEqual(readOptions(["--dry-run", "--model", "test/model"]), { dryRun: true, model: "test/model" });
  });

  it("rejects --model with no value and unknown flags", () => {
    for (const args of [["--model"], ["--model", "--dry-run"], ["--model="], ["--verbose"]]) {
      assert.equal(readOptions(args), null, args.join(" "));
    }
  });
});

describe("reading the export", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "morning-page-test-"));
  after(() => fs.rmSync(folder, { recursive: true, force: true }));

  it("gives a clear error when the file is missing or isn't valid JSON", () => {
    const brokenPath = path.join(folder, "broken.json");
    fs.writeFileSync(brokenPath, "{ not json");
    assert.throws(() => readExport(path.join(folder, "missing.json")), /couldn't be opened/);
    assert.throws(() => readExport(brokenPath), /isn't valid JSON/);
  });
});
