#!/usr/bin/env node
// Ask Buildbox whether the app's spans have arrived, using the key that is
// already in the app's environment file. The key is read to sign the request
// and is never printed.
//
//   node status.mjs --env-path ./apps/agent/.env.local [--wait 90] [--interval 5]
//
// The path flag is --env-path, not --env-file: node reads --env-file itself,
// wherever it appears on the command line. --env-file is still accepted.
//
// --wait 0 reads once and stops. Otherwise it polls until spans arrive or the
// wait runs out, backing off when Buildbox asks it to.
//
// Exit codes: 0 spans have arrived, 1 still nothing when the wait ran out,
// 2 bad arguments, no Buildbox variables in the file, or an endpoint that is
// not https, 4 Buildbox could not be reached, 5 the key was rejected.
import { readFileSync } from "node:fs";

const USAGE = "usage: node status.mjs --env-path <path> [--wait <seconds>] [--interval <seconds>]";

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
let envFile = null;
let wait = 90;
let interval = 5;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === "--env-path" || flag === "--env-file") {
    if (!value || value.startsWith("--")) fail(2, USAGE);
    envFile = value;
    i++;
  } else if (flag === "--wait" || flag === "--interval") {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) fail(2, USAGE);
    if (flag === "--wait") wait = seconds;
    else interval = seconds;
    i++;
  } else {
    fail(2, `unknown argument "${flag}"\n${USAGE}`);
  }
}
if (!envFile) fail(2, USAGE);
if (interval <= 0) interval = 5;

let text;
try {
  text = readFileSync(envFile, "utf8");
} catch {
  fail(2, `could not read ${envFile}`);
}

/** The variables in the file, quotes stripped. A minimal reader: enough for the
 *  lines this skill writes, and it never echoes what it read. */
function readEnv(source) {
  const values = {};
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

const env = readEnv(text);

/** The standard variable holds `Authorization=Bearer%20<key>`, possibly beside
 *  other headers after a comma, because several OTel SDKs parse it as baggage.
 *  The dedicated variable holds a runtime header value, `Bearer <key>`. */
function fromStandard(values) {
  const endpoint = values.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const headers = values.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  if (!endpoint || !headers) return null;
  for (const part of headers.split(",")) {
    const match = part.trim().match(/^Authorization\s*=\s*Bearer(?:%20|\s+)(.+)$/i);
    if (match) return { endpoint, key: match[1].trim() };
  }
  return null;
}

function fromDedicated(values) {
  const endpoint = values.BUILDBOX_OTLP_TRACES_ENDPOINT;
  const authorization = values.BUILDBOX_OTLP_TRACES_AUTHORIZATION;
  if (!endpoint || !authorization) return null;
  const key = authorization.replace(/^Bearer\s+/i, "").trim();
  return key ? { endpoint, key } : null;
}

const connection = fromStandard(env) ?? fromDedicated(env);
if (!connection) {
  fail(
    2,
    `no Buildbox endpoint and key in ${envFile}. Expected OTEL_EXPORTER_OTLP_TRACES_ENDPOINT with OTEL_EXPORTER_OTLP_TRACES_HEADERS, or BUILDBOX_OTLP_TRACES_ENDPOINT with BUILDBOX_OTLP_TRACES_AUTHORIZATION.`,
  );
}

/** The key signs this request, so it goes over https. Plain http is allowed
 *  only against the developer's own machine. */
function endpointAllowed(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

if (!endpointAllowed(connection.endpoint)) {
  fail(
    2,
    `the endpoint in ${envFile} has to be https, or http on localhost: got ${connection.endpoint}`,
  );
}

const url = `${connection.endpoint.replace(/\/+$/, "")}/status`;
const sleep = (seconds) => new Promise((done) => setTimeout(done, seconds * 1000));

/** Seconds to hold off for, from a Retry-After header in either allowed form. */
function retryAfter(response) {
  const header = response.headers.get("retry-after");
  if (!header) return interval;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const when = Date.parse(header);
  return Number.isNaN(when) ? interval : Math.max(0, (when - Date.now()) / 1000);
}

const deadline = Date.now() + wait * 1000;
let body = null;

for (;;) {
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${connection.key}` } });
  } catch {
    fail(4, `could not reach Buildbox at ${url}. Check the endpoint and the network.`);
  }

  if (response.status === 401) {
    fail(5, "Buildbox rejected the key: the key in the env file is not the live one.");
  }

  if (response.status === 429) {
    const hold = Math.max(retryAfter(response), 1);
    if (Date.now() + hold * 1000 > deadline) {
      // A rate limit is not an answer. Exiting 1 here would read as "nothing
      // has arrived", which this run cannot know.
      fail(
        4,
        `Buildbox rate-limited the status read and asked for ${Math.ceil(hold)} seconds; ` +
          "run this again after that. This says nothing about whether spans arrived.",
      );
    }
    console.error("waiting");
    await sleep(hold);
    continue;
  }

  if (response.ok) {
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      fail(4, "Buildbox did not answer the status read with JSON.");
    }
    body = parsed;
    if (Number(parsed?.spans_accepted ?? 0) > 0) {
      console.error("arrived");
      console.log(JSON.stringify(body));
      process.exit(0);
    }
  } else if (Date.now() + interval * 1000 > deadline) {
    fail(4, `Buildbox answered ${response.status} to the status read.`);
  }

  console.error("waiting");
  if (Date.now() + interval * 1000 > deadline) break;
  await sleep(interval);
}

if (body !== null) console.log(JSON.stringify(body));
process.exit(1);
