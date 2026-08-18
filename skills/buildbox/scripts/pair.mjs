#!/usr/bin/env node
// Redeem a Buildbox pairing code for the app's environment lines and write them
// into the environment file. The key travels from Buildbox into that file and
// nowhere else: it is never printed, logged, or returned to the caller.
//
//   node pair.mjs --code bbx_pair_... --endpoint https://api.heybuildbox.com/v1/traces \
//     --env-path ./apps/agent/.env.local [--dedicated]
//
// The path flag is --env-path, not --env-file: node reads --env-file itself,
// wherever it appears on the command line, and exits before this script runs
// when that file does not exist yet. --env-file is still accepted for an app
// whose file is already there.
//
// --dedicated writes the BUILDBOX_OTLP_TRACES_* pair instead of the three
// standard OTEL_ lines, for an app that keeps an existing trace backend.
//
// The environment file is checked for reading and writing before the code is
// posted, because the code is spent the moment Buildbox answers and a
// permission problem found after that costs the customer a new code.
//
// Exit codes: 0 wrote the lines, 2 bad arguments or an environment file this
// script cannot read or write, 3 the code is spent or expired, 4 Buildbox could
// not be reached or did not answer with usable JSON, 6 the code was redeemed
// but the write failed. On 2, 3, and 4 nothing was written and the code was not
// spent by this run; on 6 the code is spent and the key is gone.
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const USAGE =
  "usage: node pair.mjs --code <code> --endpoint <url> --env-path <path> [--dedicated]";

const SPENT =
  "This pairing code is not valid any more. Ask the customer to click New command on the Buildbox setup screen and give you the new code.";

const LOST =
  "The pairing code was redeemed but the env file could not be written; the key was not saved anywhere. Fix the file permissions, then ask the customer for a new command.";

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
const options = { code: null, endpoint: null, envFile: null, dedicated: false };
const FLAGS = {
  "--code": "code",
  "--endpoint": "endpoint",
  "--env-path": "envFile",
  "--env-file": "envFile",
};
for (let i = 0; i < argv.length; i++) {
  const key = FLAGS[argv[i]];
  if (key) {
    const value = argv[++i] ?? null;
    if (!value || value.startsWith("--")) fail(2, USAGE);
    options[key] = value;
  } else if (argv[i] === "--dedicated") {
    options.dedicated = true;
  } else {
    fail(2, `unknown argument "${argv[i]}"\n${USAGE}`);
  }
}
if (!options.code || !options.endpoint || !options.envFile) fail(2, USAGE);

/** The code and the key ride on this request, so it goes over https. Plain http
 *  is allowed only against the developer's own machine. */
function endpointAllowed(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

if (!endpointAllowed(options.endpoint)) {
  fail(2, `the --endpoint has to be https, or http on localhost: got ${options.endpoint}`);
}

const endpoint = options.endpoint.replace(/\/+$/, "");

// Read the file before the code is posted. A file that is there but unreadable
// is not an absent file: writing a fresh one would throw the customer's own
// variables away.
let existing = "";
let fileExists = false;
let existingMode = null;
try {
  existing = readFileSync(options.envFile, "utf8");
  fileExists = true;
  existingMode = statSync(options.envFile).mode & 0o777;
} catch (error) {
  const code = error?.code;
  // ENOTDIR means a path component is a file, which the ancestor check below
  // reports against the right part of the path.
  if (code !== "ENOENT" && code !== "ENOTDIR") {
    fail(
      2,
      `could not read ${options.envFile}: ${code ?? "read failed"}. Fix the file permissions, then run this again.`,
    );
  }
}

if (fileExists) {
  try {
    accessSync(options.envFile, constants.W_OK);
  } catch {
    fail(2, `cannot write ${options.envFile}. Fix the file permissions, then run this again.`);
  }
} else {
  // The write creates the missing directories, so the nearest directory that
  // does exist is the one that has to accept them.
  let ancestor = resolve(dirname(options.envFile));
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(ancestor).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) fail(2, `cannot create ${options.envFile}: ${ancestor} is not a directory.`);
  try {
    accessSync(ancestor, constants.W_OK);
  } catch {
    fail(
      2,
      `cannot create ${options.envFile}: ${ancestor} is not writable. Fix the directory permissions, then run this again.`,
    );
  }
}

let response;
try {
  response = await fetch(`${endpoint}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: options.code }),
  });
} catch {
  fail(4, `could not reach Buildbox at ${endpoint}/pair. Check the endpoint and the network.`);
}

if (response.status === 404 || response.status === 410) fail(3, SPENT);
if (response.status === 429) {
  fail(4, "Buildbox is rate limiting the pairing request. Wait a minute and run this again.");
}
if (!response.ok) {
  fail(4, `Buildbox answered ${response.status} to the pairing request. Nothing was written.`);
}

let payload;
try {
  payload = await response.json();
} catch {
  fail(4, "Buildbox did not answer with JSON. Nothing was written.");
}

const lines = options.dedicated ? payload?.dedicated_env_lines : payload?.env_lines;
if (!Array.isArray(lines) || lines.length === 0) {
  fail(4, "The pairing answer carried no environment lines. Nothing was written.");
}

// Only NAME=value lines are written, so nothing unexpected in the answer can
// end up in the customer's environment file.
const wanted = [];
for (const line of lines) {
  if (typeof line !== "string") continue;
  const match = line.replace(/\r?\n$/, "").match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (match) wanted.push({ name: match[1], line: line.replace(/\r?\n$/, "").trim() });
}
if (wanted.length === 0) {
  fail(4, "The pairing answer carried no environment lines. Nothing was written.");
}

// Replace a variable already in the file where it stands, so the customer's own
// ordering, indentation, `export` prefix, and comments survive; append the
// rest. A later duplicate of the same variable goes, because dotenv and
// python-dotenv both take the last line and a stale copy below would win.
const outputLines = existing === "" ? [] : existing.split("\n");
const trailingBlank = outputLines.length > 0 && outputLines.at(-1) === "";
if (trailingBlank) outputLines.pop();

let duplicates = 0;
for (const variable of wanted) {
  const pattern = new RegExp(`^(\\s*)(export\\s+)?${variable.name}\\s*=`);
  let at = -1;
  for (let i = 0; i < outputLines.length; i++) {
    const line = outputLines[i];
    if (line === null || !pattern.test(line)) continue;
    if (at === -1) {
      at = i;
      continue;
    }
    outputLines[i] = null;
    duplicates++;
  }
  if (at === -1) {
    outputLines.push(variable.line);
    continue;
  }
  const [, indent, exported] = pattern.exec(outputLines[at]);
  const body = variable.line.replace(/^\s*export\s+/, "");
  const keepExport = Boolean(exported) || /^\s*export\s+/.test(variable.line);
  outputLines[at] = `${indent}${keepExport ? "export " : ""}${body}`;
}

const finalLines = outputLines.filter((line) => line !== null);

try {
  if (fileExists) {
    // An existing file keeps the permissions the customer gave it.
    writeFileSync(options.envFile, `${finalLines.join("\n")}\n`);
  } else {
    mkdirSync(dirname(options.envFile), { recursive: true });
    writeFileSync(options.envFile, `${finalLines.join("\n")}\n`, { mode: 0o600 });
    chmodSync(options.envFile, 0o600);
  }
} catch {
  fail(6, LOST);
}

const names = wanted.map((variable) => variable.name).join(", ");
const plural = duplicates === 1 ? "line" : "lines";
const removed = duplicates === 0 ? "" : ` (removed ${duplicates} duplicate ${plural})`;
console.log(`wrote ${wanted.length} variables to ${options.envFile}: ${names}${removed}`);
if (existingMode !== null && (existingMode & 0o044) !== 0) {
  console.warn(
    `warning: ${options.envFile} can be read by other users on this machine. Tighten it with chmod 600 ${options.envFile}`,
  );
}
if (typeof payload?.status_url === "string" && payload.status_url) {
  console.log(`status: ${payload.status_url}`);
}
