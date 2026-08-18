#!/usr/bin/env node
// Ask Buildbox whether the app's spans have arrived, using the key that is
// already in the app's environment file. The key is read to sign the request
// and is never printed.
//
//   node status.mjs --env-path ./apps/agent/.env.local [--wait 90] [--interval 5]
//     [--baseline 3 [--new-conversations 1] [--settle 30]]
//
// The path flag is --env-path, not --env-file: node reads --env-file itself,
// wherever it appears on the command line. --env-file is still accepted.
//
// --wait 0 reads once and stops. Otherwise it polls until spans arrive or the
// wait runs out, backing off when Buildbox asks it to.
//
// --baseline <n> turns the read into a delta check around one interaction: n is
// the conversations_seen value read before the interaction, and the check waits
// for the count to reach n plus --new-conversations <k>, which is one by
// default and is one per conversation id sent. A floor like "at least one
// conversation" proves nothing on a connection that already had conversations,
// and spans alone are weaker still: a Next.js app's HTTP spans count towards
// spans_accepted, so that number can go green on a setup with no model
// telemetry and no conversation grouping at all.
//
// Once the count first reaches n + k the check keeps reading for --settle
// <seconds>, 30 by default, and judges the read that closes that window rather
// than the first read above the target. The count is not monotonic while
// Buildbox is still assembling: it climbs by one and merges back down within
// about a minute, so a single high read says nothing. Only an overshoot that
// survives the window is broken grouping.
//
// At the close: still climbing, meaning the closing read is above the one
// before it, extends the window once more; equal to the target exits 0; above
// the target exits 1; below the target means the count merged back down, so the
// run goes back to waiting for it inside the remaining --wait. Worst case is
// --wait plus two settle windows.
//
// Exit codes: 0 spans have arrived, and the conversation delta was met and
// settled when one was asked for, 1 still nothing when the wait ran out, or the
// delta was never reached, or the count settled above it, 2 bad arguments, no
// Buildbox variables in the file, an endpoint that is not https, or a baseline
// too close to the count's cap for a delta to prove anything, 4 Buildbox could
// not be reached, 5 the key was rejected.
import { readFileSync } from "node:fs";

const USAGE =
  "usage: node status.mjs --env-path <path> [--wait <seconds>] [--interval <seconds>] " +
  "[--baseline <n> [--new-conversations <k>] [--settle <seconds>]]";

// The status read counts conversations up to 1000 and answers 1000 for "1000 or
// more", so a baseline at the cap is not a number to measure a delta from: it
// cannot be told apart from any larger one.
const CONVERSATIONS_CAP = 1000;

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
let envFile = null;
let wait = 90;
let interval = 5;
let settle = 30;
let baseline = null;
let newConversations = null;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const value = argv[i + 1];
  if (flag === "--env-path" || flag === "--env-file") {
    if (!value || value.startsWith("--")) fail(2, USAGE);
    envFile = value;
    i++;
  } else if (flag === "--baseline" || flag === "--new-conversations") {
    const count = Number(value);
    if (!Number.isInteger(count)) fail(2, USAGE);
    if (flag === "--baseline") {
      if (count < 0) fail(2, USAGE);
      baseline = count;
    } else {
      // Zero new conversations would make the target the baseline itself, which
      // is the floor this flag exists to replace.
      if (count < 1) fail(2, USAGE);
      newConversations = count;
    }
    i++;
  } else if (flag === "--wait" || flag === "--interval" || flag === "--settle") {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) fail(2, USAGE);
    if (flag === "--wait") wait = seconds;
    else if (flag === "--settle") settle = seconds;
    else interval = seconds;
    i++;
  } else {
    fail(2, `unknown argument "${flag}"\n${USAGE}`);
  }
}
if (!envFile) fail(2, USAGE);
if (interval <= 0) interval = 5;
if (newConversations !== null && baseline === null) {
  fail(
    2,
    "--new-conversations needs --baseline <n>, the conversations_seen value read " +
      `before the interaction.\n${USAGE}`,
  );
}

// How many new conversations this run is waiting for, and the count that means
// it got them. Null target is the plain read: spans arrived, nothing more.
const expected = newConversations ?? 1;
const target = baseline === null ? null : baseline + expected;
// The target itself has to sit below the cap: a target of exactly the cap reads
// the same whether one conversation arrived or ten, so an overshoot there is
// invisible and the check would pass a broken grouping.
if (target !== null && target >= CONVERSATIONS_CAP) {
  fail(
    2,
    `conversations_seen is counted up to ${CONVERSATIONS_CAP} and ${CONVERSATIONS_CAP} means ` +
      `"or more", so a delta check from a baseline of ${baseline} expecting ${expected} ` +
      "more cannot be proved. Read the grouping off the Sessions screen instead.",
  );
}

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

/** How many conversations Buildbox has grouped for this connection, or null
 *  when it did not say. Null is not zero: an older Buildbox does not return the
 *  field at all, and reading that as "no conversations" would send the caller
 *  to a grouping problem that may not exist. */
function conversationsSeen(answer) {
  const count = answer?.conversations_seen;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

const deadline = Date.now() + wait * 1000;
let body = null;

/** Every ending goes through here, so the last answer is printed exactly once
 *  and the reason for the exit code is always beside it. */
function finish(code, message) {
  if (body !== null) console.log(JSON.stringify(body));
  if (message) console.error(message);
  process.exit(code);
}

const overshot = (seen) =>
  `conversations_seen settled at ${seen}` +
  (peak !== null && peak > seen ? `, after a peak of ${peak}` : "") +
  `, past the ${target} this run expected ` +
  `(baseline ${baseline} plus ${expected}): more conversations than turns you sent under one ` +
  "conversation id, so the grouping is broken. Check troubleshooting rung 6.";

// Set when the target is first reached: from then on the run is holding the
// count still rather than waiting for it to rise.
let settleUntil = null;
// One extension per settle window, spent when the count is still climbing as
// the window closes.
let extended = false;
// The read before the current one, inside the window, and the highest count
// this run has seen. The peak is worth reporting because a transient split is
// the normal reason a run sees one.
let previousSeen = null;
let peak = null;

/** Print the in-window line and wait, but never past the end of the window: a
 *  window that never reads again would pass a split conversation exactly the
 *  way a floor did. */
async function holdInWindow(seen) {
  console.error(`settling, conversations_seen: ${seen}`);
  const left = Math.max((settleUntil - Date.now()) / 1000, 0.001);
  await sleep(Math.min(interval, left));
}

for (;;) {
  let note = "waiting";
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
      if (target === null) finish(0, "arrived");
      const seen = conversationsSeen(parsed);
      if (seen === null) {
        // Waiting cannot make an absent field appear, so this is the answer.
        finish(
          1,
          "spans arrived, but this Buildbox did not report conversations_seen, so the " +
            "conversation check could not run. Read the grouping off the Sessions screen instead.",
        );
      }
      if (peak === null || seen > peak) peak = seen;
      if (settleUntil === null) {
        // Reaching the target, or passing it, opens the settle window. A first
        // read above the target is not the verdict: the count over-counts
        // transiently while batches are still being merged.
        if (seen >= target) {
          // A single read (--wait 0) or no settle window asked for: the first
          // read is the verdict, because there is nothing to hold for.
          if (settle <= 0 || wait <= 0) {
            if (seen === target) finish(0, `arrived, conversations_seen: ${seen}`);
            finish(1, overshot(seen));
          }
          settleUntil = Date.now() + settle * 1000;
          extended = false;
          previousSeen = seen;
          await holdInWindow(seen);
          continue;
        }
        note = `waiting, conversations_seen: ${seen}`;
      } else if (Date.now() < settleUntil) {
        previousSeen = seen;
        await holdInWindow(seen);
        continue;
      } else if (seen > previousSeen && !extended) {
        // Still climbing as the window closes, so assembly is not finished and
        // there is nothing to judge yet. This arm comes before the verdicts on
        // purpose: a count above the target that is still moving is exactly the
        // case the extension exists for, and judging first would make it dead
        // code.
        extended = true;
        settleUntil = Date.now() + settle * 1000;
        previousSeen = seen;
        await holdInWindow(seen);
        continue;
      } else if (seen === target) {
        finish(0, `arrived, conversations_seen: ${seen}`);
      } else if (seen > target) {
        // An overshoot that survived the window: the turns landed as separate
        // conversations, which is the failure this check is for.
        finish(1, overshot(seen));
      } else {
        // Merged back below the target, so it was never settled. Go back to
        // waiting for it inside whatever is left of --wait.
        settleUntil = null;
        extended = false;
        previousSeen = null;
        note = `waiting, conversations_seen: ${seen}`;
      }
    }
  } else if (Date.now() + interval * 1000 > deadline) {
    fail(4, `Buildbox answered ${response.status} to the status read.`);
  }

  console.error(note);
  if (Date.now() + interval * 1000 > deadline) break;
  await sleep(interval);
}

if (target !== null && Number(body?.spans_accepted ?? 0) > 0) {
  finish(
    1,
    `spans arrived but the conversations have not: conversations_seen is ` +
      `${conversationsSeen(body)}, and this run was waiting for ${target} ` +
      `(baseline ${baseline} plus ${expected}). Check conversation grouping, ` +
      "troubleshooting rung 6.",
  );
}
finish(1, null);
