#!/usr/bin/env node
// Report which route of the buildbox skill's ladder applies to an app, by
// reading its dependency manifests. Reads only: no network, no writes.
//
//   node detect.mjs --dir ./apps/agent [--json]
//
// A manifest is evidence, not proof: a package can be declared and never used.
// Every match is reported, not just the winning one, so the reading agent can
// override the verdict from the entrypoint, which is the only thing that
// actually settles it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = "usage: node detect.mjs --dir <path> [--json]";

const argv = process.argv.slice(2);
let dir = null;
let json = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dir") {
    const value = argv[++i] ?? null;
    if (!value || value.startsWith("--")) {
      console.error(USAGE);
      process.exit(2);
    }
    dir = value;
  } else if (argv[i] === "--json") {
    json = true;
  } else {
    console.error(`unknown argument "${argv[i]}"\n${USAGE}`);
    process.exit(2);
  }
}
if (!dir) {
  console.error(USAGE);
  process.exit(2);
}

const NODE_MANIFEST = "package.json";
const PYTHON_MANIFESTS = ["pyproject.toml", "requirements.txt"];
const seen = [];

/** Read a manifest, or null when it is absent or unreadable. A missing one is
 *  the normal case; all three missing is a mistyped `--dir`, which is reported
 *  rather than answered, because route 5 is the one route that writes new code
 *  and it must not be reached by never opening the app. */
function read(name) {
  try {
    const text = readFileSync(join(dir, name), "utf8");
    seen.push(name);
    return text;
  } catch {
    return null;
  }
}

/** Every dependency name declared in package.json, across all groups. */
function nodePackages() {
  const raw = read(NODE_MANIFEST);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`warning: ${join(dir, NODE_MANIFEST)} is not valid JSON, skipping it`);
    return [];
  }
  const groups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return groups.flatMap((group) => Object.keys(parsed?.[group] ?? {}));
}

/** Distribution names from pyproject.toml and requirements.txt.
 *
 *  Line-scanned rather than parsed, because a TOML parser is a dependency and
 *  this script has none. It takes the leading token of every non-comment line,
 *  which covers both `"langchain-core>=0.3",` in a dependency array and
 *  `openai==1.2.0` in a requirements file. Inline PEP 621 arrays are scanned
 *  for every quoted value. Non-dependency lines yield junk tokens that simply
 *  match nothing. */
function pythonPackages() {
  const names = [];
  const addLeadingToken = (value) => {
    const token = value.match(/^["']?([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (token) names.push(token[1].toLowerCase().replace(/_/g, "-"));
  };
  for (const file of PYTHON_MANIFESTS) {
    for (const raw of (read(file) ?? "").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      addLeadingToken(line);
      if (/=\s*\[/.test(line)) {
        for (const match of line.matchAll(/["']([^"']+)["']/g)) {
          addLeadingToken(match[1]);
        }
      }
    }
  }
  return names;
}

const nodeDeps = nodePackages();
const pyDeps = pythonPackages();

/** A name ending in `/` or `-` is a prefix; anything else must match exactly. */
function hits(declared, patterns) {
  return declared.filter((name) =>
    patterns.some((pattern) =>
      /[/-]$/.test(pattern) ? name.startsWith(pattern) : name === pattern,
    ),
  );
}

// Ordered lightest route first: the first rung that matches wins, because the
// ladder's whole point is to add as little as possible.
const RUNGS = [
  {
    route: 1,
    framework: "existing OpenTelemetry",
    // API-only, metrics-only, and logs-only packages do not establish trace export.
    node: [
      "@opentelemetry/sdk-node",
      "@opentelemetry/sdk-trace-node",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/exporter-trace-otlp-proto",
      "@opentelemetry/exporter-trace-otlp-http",
      "@vercel/otel",
    ],
    python: [
      "opentelemetry-sdk",
      "opentelemetry-exporter-otlp",
      "opentelemetry-exporter-otlp-",
    ],
  },
  // Vercel AI SDK only; the bare `ai` name has no Python distribution.
  { route: 2, framework: "Vercel AI SDK", node: ["ai"], python: [] },
  {
    route: 3,
    framework: "LangChain / LangGraph",
    node: ["langchain", "@langchain/"],
    python: ["langchain", "langchain-", "langgraph"],
  },
  {
    route: 4,
    framework: "OpenAI Agents SDK",
    node: ["@openai/agents"],
    python: ["openai-agents"],
  },
  { route: 4, framework: "OpenAI SDK", node: ["openai"], python: ["openai"] },
  {
    route: 4,
    framework: "Anthropic SDK",
    node: ["@anthropic-ai/"],
    python: ["anthropic"],
  },
];

const evidence = [];
let verdict = null;
for (const rung of RUNGS) {
  const found = [...hits(nodeDeps, rung.node), ...hits(pyDeps, rung.python)];
  if (found.length === 0) continue;
  for (const name of new Set(found)) evidence.push(`${rung.framework}: ${name}`);
  if (!verdict) verdict = rung;
}

const nothingRead = seen.length === 0;
const result = {
  route: verdict?.route ?? 5,
  framework: nothingRead ? "no manifests found" : (verdict?.framework ?? "none recognized"),
  evidence,
};

if (nothingRead) {
  const names = [NODE_MANIFEST, ...PYTHON_MANIFESTS].join(", ");
  console.error(`warning: no ${names} under "${dir}". Check --dir.`);
}

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const NOTES = {
    1: "Confirm a tracer provider starts and the model calls run inside it. Preserve any existing standard OTLP destination.",
    2: "Check the installed ai major, apply its telemetry recipe, then add the env block.",
    3: "Register an OpenInference or OpenLLMetry instrumentor at startup, then add the env block.",
    4: "Register the matching OpenInference or OpenLLMetry instrumentor, then add the env block.",
    5: "Nothing recognized. Wrap the model call in a manual OTel tracer, then add the env block.",
  };
  console.log(`route ${result.route}: ${result.framework}`);
  console.log(
    nothingRead
      ? "Nothing was read, so nothing was ruled out. Point --dir at the app that talks to the model."
      : NOTES[result.route],
  );
  if (evidence.length > 0) {
    console.log("\nevidence:");
    for (const item of evidence) console.log(`  ${item}`);
  }
  if (!nothingRead) {
    console.log("\nA manifest entry is not proof spans are emitted. Confirm at the entrypoint.");
  }
}

if (nothingRead) process.exit(1);
