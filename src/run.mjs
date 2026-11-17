// Runs the Morning Page logic on the pen pages in the export and writes what the user would have seen.
// Use `node src/run.mjs --dry-run` to try it without a key, or leave the flag off to call the model.
// The OpenRouter key comes from OPENROUTER_API_KEY or a hidden prompt, and is never stored.

import fs from "node:fs";
import readline from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_MODEL, ENV_PATH, EXPORT_PATH, MAX_ATTEMPTS, OPENROUTER_URL, REPORT_PATH, TIMEOUT_MS,
} from "./config.mjs";
import { runProof } from "./morning_page.mjs";
import { buildReport } from "./helpers.mjs";

const USAGE = "Usage: node src/run.mjs [--dry-run] [--model <model id>]";
const CLI_OPTIONS = {
  "dry-run": { type: "boolean", default: false },
  model: { type: "string", default: DEFAULT_MODEL },
};

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (!options) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const exportData = readExport(EXPORT_PATH);
  const apiKey = options.dryRun ? null : await readApiKey();
  const sendRequest = (request) => sendToOpenRouter(request, apiKey, fetch);
  const proof = await runProof(exportData, { ...options, sendRequest });

  if (options.dryRun) printWhatWouldBeSent(proof.pages);
  if (proof.keyRejected) console.error("The key was rejected. Check it and try again.");
  fs.writeFileSync(REPORT_PATH, buildReport(proof));
  console.log(`Wrote the report to ${REPORT_PATH}.`);
}

export function readOptions(args) {
  try {
    const { values } = parseArgs({ args, options: CLI_OPTIONS });
    return values.model ? { dryRun: values["dry-run"], model: values.model } : null;
  } catch {
    // parseArgs throws on unknown flags and on --model with no value. Both get the usage message.
    return null;
  }
}

export function readExport(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const problem = error instanceof SyntaxError ? "isn't valid JSON" : "couldn't be opened";
    throw new Error(`The export at ${filePath} ${problem}.`);
  }
}

async function readApiKey() {
  // A key already set in the shell wins over the one in .env, the same way Node's --env-file works.
  if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  const apiKey = process.env.OPENROUTER_API_KEY || (await askHidden("OpenRouter API key (typing is hidden): "));
  if (!apiKey) throw new Error("No key given. Use --dry-run to try it without one.");
  return apiKey;
}

// readline writes to a stream that drops everything, so the key isn't echoed as it's typed.
function askHidden(question) {
  process.stdout.write(question);
  const silentOutput = new Writable({ write: (_chunk, _encoding, done) => done() });
  const prompt = readline.createInterface({ input: process.stdin, output: silentOutput, terminal: true });
  return new Promise((resolve) => {
    prompt.question("", (answer) => {
      prompt.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

export async function sendToOpenRouter(request, apiKey, fetchFn) {
  const startedAt = performance.now();
  let result;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    result = await callOpenRouterOnce(request, apiKey, fetchFn);
    if (!result.retry) break;
  }
  return { ...result, seconds: (performance.now() - startedAt) / 1000 };
}

async function callOpenRouterOnce(request, apiKey, fetchFn) {
  try {
    const response = await fetchFn(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return describeHttpError(response.status);
    return readModelReply(await response.text());
  } catch (error) {
    // Only the error's name is used. The error itself is never copied, so nothing from the request can leak.
    const timedOut = error.name === "TimeoutError";
    return { error: timedOut ? "the call timed out" : "couldn't reach OpenRouter", retry: true };
  }
}

function describeHttpError(status) {
  if (status === 401 || status === 403) return { error: "the key was rejected", keyRejected: true };
  // Rate limits and server errors often pass, so they get one retry. Other errors would fail the same way again.
  return { error: `OpenRouter answered with HTTP ${status}`, retry: status === 429 || status >= 500 };
}

function readModelReply(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { error: "the reply wasn't valid JSON" };
  }
  if (!Array.isArray(body?.choices) || body.choices.length === 0) return { error: "the reply had no choices" };
  const cost = body.usage?.cost;
  return { text: body.choices[0].message?.content, cost: typeof cost === "number" ? cost : null };
}

function printWhatWouldBeSent(pages) {
  const pagesToSend = pages.filter((page) => page.outcome === "not_run");
  for (const page of pagesToSend) {
    console.log(`${page.id} would send:\n${JSON.stringify(page.input, null, 2)}\n`);
  }
}

// Only run when started from the command line, so the tests can import the functions above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
