#!/usr/bin/env node
// Report which route of the buildbox skill's ladder applies to an app, plus the
// facts the skill would otherwise have to ask a human for: which directory the
// app lives in, which files call a model, how the app restarts, and which
// environment file it reads. Reads only: no network, no writes.
//
//   node detect.mjs [--dir ./apps/agent] [--json]
//
// A manifest is evidence, not proof: a package can be declared and never used.
// Every match is reported, not just the winning one, so the reading agent can
// override the verdict from the entrypoint, which is the only thing that
// actually settles it. Everything below the route ladder is a hint of the same
// kind: a field that cannot be worked out degrades to null or an empty list, so
// the caller can tell "nothing found" from "found nothing to worry about".
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const USAGE = "usage: node detect.mjs [--dir <path>] [--json]";

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

const NODE_MANIFEST = "package.json";
const PYTHON_MANIFESTS = ["pyproject.toml", "requirements.txt"];
const MANIFESTS = [NODE_MANIFEST, ...PYTHON_MANIFESTS];

// Directories that are never the customer's own source. Anything hidden is
// skipped too, which covers .git, .venv, .next, and the rest of the dot noise.
const SKIP_DIRS = new Set(["node_modules", "venv", "dist", "build", "__pycache__", "coverage"]);
const skipped = (name) => name.startsWith(".") || SKIP_DIRS.has(name);

/** Read a file, or null when it is absent or unreadable. Large files are
 *  skipped rather than pulled into memory. */
function readText(path, limit = 512_000) {
  try {
    if (statSync(path).size > limit) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Does the path exist? Cheaper than reading it, and the answer is all the
 *  lockfile and manifest probes need. */
function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  const raw = readText(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function subdirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !skipped(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

const isApp = (path) => MANIFESTS.some((name) => exists(join(path, name)));

/** Every directory with a dependency manifest, at the working directory and one
 *  and two levels under it. Two levels reaches `apps/web` and `services/api`
 *  without walking a whole monorepo. */
function findApps(root) {
  const found = [];
  if (isApp(root)) found.push(join(root));
  for (const first of subdirectories(root)) {
    const one = join(root, first);
    if (isApp(one)) found.push(one);
    for (const second of subdirectories(one)) {
      const two = join(one, second);
      if (isApp(two)) found.push(two);
    }
  }
  return found;
}

let apps = [];
try {
  apps = dir ? [join(dir)] : findApps(".");
} catch {
  apps = [];
}

// With --dir the caller has settled the question. Without it, a single
// candidate settles it just as well; two or more is the one thing the skill
// still has to ask about, so the ladder falls back to the working directory.
const appDir = dir ? join(dir) : apps.length === 1 ? apps[0] : ".";

const seen = [];

/** Read a manifest from the selected app directory, recording that it existed.
 *  A missing one is the normal case; all three missing is a mistyped `--dir`,
 *  which is reported rather than answered, because route 5 is the one route
 *  that writes new code and it must not be reached by never opening the app. */
function read(name) {
  const text = readText(join(appDir, name));
  if (text !== null) seen.push(name);
  return text;
}

/** Every dependency name declared in package.json, across all groups. */
function nodePackages() {
  const raw = read(NODE_MANIFEST);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`warning: ${join(appDir, NODE_MANIFEST)} is not valid JSON, skipping it`);
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

// ---------------------------------------------------------------------------
// Entrypoints: the files that import a model client or an agent framework.
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".py"];
const MODEL_MODULES = [
  "ai",
  "openai",
  "@anthropic-ai/sdk",
  "anthropic",
  "langchain",
  "@langchain/",
  "langgraph",
  "@openai/agents",
  "openai-agents",
];
// Python imports the distributions above under these top-level module names.
const PYTHON_MODEL_MODULES = ["openai", "anthropic", "langchain", "langgraph", "agents"];

const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
];

function importsModel(text) {
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      const hit = MODEL_MODULES.some((name) =>
        name.endsWith("/")
          ? specifier.startsWith(name)
          : specifier === name || specifier.startsWith(`${name}/`),
      );
      if (hit) return true;
    }
  }
  return false;
}

function importsModelPython(text) {
  const roots = [];
  for (const match of text.matchAll(/^[ \t]*from[ \t]+([A-Za-z0-9_.]+)/gm)) roots.push(match[1]);
  for (const match of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const part of match[1].split(",")) {
      const first = part.trim().split(/[ \t]+/)[0];
      if (first) roots.push(first);
    }
  }
  return roots.some((raw) => {
    const root = raw.split(".")[0].toLowerCase();
    return PYTHON_MODEL_MODULES.some((name) => root === name || root.startsWith(`${name}_`));
  });
}

/** Up to 20 files under the app directory that import a model client. Bounded
 *  in both matches and files opened, so it stays fast in a large repo. */
function findEntrypoints(root) {
  const found = [];
  let opened = 0;
  const walk = (path) => {
    if (found.length >= 20 || opened >= 2000) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= 20 || opened >= 2000) return;
      if (!entry.isFile()) continue;
      if (!CODE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
      const file = join(path, entry.name);
      const text = readText(file);
      opened += 1;
      if (text === null) continue;
      const matched = entry.name.endsWith(".py") ? importsModelPython(text) : importsModel(text);
      if (matched) found.push(file);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !skipped(entry.name)) walk(join(path, entry.name));
    }
  };
  walk(root);
  return found;
}

// ---------------------------------------------------------------------------
// Restart command: how the app comes back up after the env file changes.
// ---------------------------------------------------------------------------

function packageRunner(path) {
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun run"],
    ["bun.lock", "bun run"],
    ["package-lock.json", "npm run"],
  ];
  for (const root of [path, "."]) {
    for (const [name, runner] of lockfiles) {
      if (exists(join(root, name))) return runner;
    }
  }
  return "npm run";
}

function firstScript(text, section) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === section);
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) return null;
    const match = trimmed.match(/^([A-Za-z0-9._-]+)\s*=/);
    return match ? match[1] : null;
  }
  return null;
}

const UVICORN_FILES = [
  "pyproject.toml",
  "Dockerfile",
  "Procfile",
  "docker-compose.yml",
  "compose.yml",
  "README.md",
  "readme.md",
  "README.rst",
];

/** A written-down `uvicorn <module>:<app>` line, wherever the project keeps it.
 *  The README counts: the requirements.txt-plus-README layout is the most
 *  common FastAPI shape and it declares the run command nowhere else. The
 *  module:app shape is required so a dependency pin like `uvicorn[standard]`
 *  or a prose mention of the package is not read back as a command. */
function uvicornMention(path) {
  for (const name of UVICORN_FILES) {
    const text = readText(join(path, name));
    if (!text) continue;
    const match = text.match(/uvicorn\s+[A-Za-z0-9_.]+:[A-Za-z0-9_]+[^\n"'`\]]*/);
    if (match) return { command: match[0].trim(), source: `${name} (uvicorn)` };
  }
  return null;
}

const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield",
]);

/** The dotted module uvicorn would import for a file, or null when the path
 *  cannot be one. A package entrypoint is its package, so `api/__init__.py` is
 *  `api` and not `api.__init__`. A directory Python cannot name, a hyphen, a
 *  leading digit, a keyword, means there is no module here to guess a run
 *  command from, and a wrong command is worse than none. */
function pythonModule(root, file) {
  const path = relative(root, file);
  if (!path || path.startsWith("..")) return null;
  const segments = path.replace(/\.py$/, "").split(sep);
  if (segments.at(-1) === "__init__") segments.pop();
  if (segments.length === 0) return null;
  const nameable = (segment) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && !PYTHON_KEYWORDS.has(segment);
  if (!segments.every(nameable)) return null;
  return { module: segments.join("."), src: segments.length > 1 && segments[0] === "src" };
}

/** The same command worked out from the code when nothing wrote it down: a
 *  detected FastAPI entrypoint gives the module and the app variable, and
 *  `uvicorn.run(..., port=N)` in the same file gives the port. Inferred, so it
 *  says so, and every explicit source above wins over it. */
function inferUvicorn(path, entrypoints) {
  for (const file of entrypoints) {
    if (!file.endsWith(".py")) continue;
    const text = readText(file);
    if (!text) continue;
    const variable = text.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*FastAPI\s*\(/m);
    if (!variable) continue;
    const named = pythonModule(path, file);
    if (!named) continue;
    const port = text.match(/\bport\s*=\s*(\d{2,5})\b/);
    // A src layout usually installs the package as `api`, not `src.api`, and
    // then uvicorn needs to be pointed at the directory instead.
    const note = named.src
      ? "src layout, so this may need --app-dir src with the module as " +
        `${named.module.replace(/^src\./, "")}:${variable[1]} instead. Confirm it before running it.`
      : null;
    return {
      command: `uvicorn ${named.module}:${variable[1]}${port ? ` --port ${port[1]}` : ""}`,
      source: "inferred from FastAPI entrypoint",
      ...(note ? { note } : {}),
    };
  }
  return null;
}

function detectRestart(path, entrypoints = []) {
  const pkg = readJson(join(path, NODE_MANIFEST));
  const scripts = pkg?.scripts ?? {};
  for (const name of ["dev", "start"]) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      return { command: `${packageRunner(path)} ${name}`, source: `package.json scripts.${name}` };
    }
  }

  const procfile = readText(join(path, "Procfile"));
  if (procfile) {
    const lines = procfile
      .split("\n")
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/))
      .filter(Boolean);
    const web = lines.find((line) => line[1] === "web") ?? lines[0];
    if (web) return { command: web[2].trim(), source: `Procfile (${web[1]})` };
  }

  const dockerfile = readText(join(path, "Dockerfile"));
  if (dockerfile) {
    const commands = [...dockerfile.matchAll(/^\s*CMD\s+(.+)$/gim)];
    const last = commands.at(-1);
    if (last) {
      const raw = last[1].trim();
      let command = raw;
      if (raw.startsWith("[")) {
        try {
          command = JSON.parse(raw).join(" ");
        } catch {
          command = raw;
        }
      }
      return { command, source: "Dockerfile CMD" };
    }
  }

  const pyproject = readText(join(path, "pyproject.toml"));
  if (pyproject) {
    const script = firstScript(pyproject, "[project.scripts]");
    if (script) {
      const uv = exists(join(path, "uv.lock"));
      return {
        command: uv ? `uv run ${script}` : script,
        source: "pyproject.toml [project.scripts]",
      };
    }
  }

  return uvicornMention(path) ?? inferUvicorn(path, entrypoints);
}

// ---------------------------------------------------------------------------
// Environment file: which file actually supplies the variables at runtime.
// ---------------------------------------------------------------------------

function composeEnvFile(path) {
  for (const root of [path, "."]) {
    for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      const text = readText(join(root, name));
      if (!text) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const inline = lines[i].match(/^\s*env_file:\s*(.*)$/);
        if (!inline) continue;
        const value = inline[1].trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "");
        if (value && !value.startsWith("#")) {
          return { path: join(root, value), reason: `${name} declares env_file` };
        }
        for (const next of lines.slice(i + 1)) {
          const item = next.match(/^\s*-\s*(.+)$/);
          if (!item) break;
          const listed = item[1].trim().replace(/^["']|["']$/g, "");
          if (listed) return { path: join(root, listed), reason: `${name} declares env_file` };
        }
      }
    }
  }
  return null;
}

function detectEnvFile(path) {
  const pkg = readJson(join(path, NODE_MANIFEST));
  const declared = ["dependencies", "devDependencies"].flatMap((group) =>
    Object.keys(pkg?.[group] ?? {}),
  );
  let hasNextConfig = false;
  try {
    hasNextConfig = readdirSync(path).some((name) => name.startsWith("next.config."));
  } catch {
    hasNextConfig = false;
  }
  if (declared.includes("next") || hasNextConfig) {
    return { path: join(path, ".env.local"), reason: "Next.js reads .env.local" };
  }

  const compose = composeEnvFile(path);
  if (compose) return compose;

  return { path: join(path, ".env"), reason: "dotenv default" };
}

/** Say whether the file that was worked out is actually there. A safety verdict
 *  about a file that does not exist reads as an all-clear, and the file the app
 *  really loads may be somewhere else entirely. The git checks still run: they
 *  answer for the path, not for the bytes, and the pattern has to be in place
 *  before the key is written. */
function describeEnvFile(found) {
  if (!found) return null;
  if (exists(found.path)) return { ...found, exists: true };
  return { ...found, exists: false, note: "file does not exist yet" };
}

/** Is that environment file ignored by git, and is it already tracked? Tracked
 *  is the dangerous one: an ignore rule does not untrack a file that is already
 *  committed. `checked: false` means git could not answer, not that the file is
 *  safe. */
function checkEnvFileSafety(path, envFile) {
  const run = (args) => {
    try {
      execFileSync("git", args, { cwd: resolve(path), stdio: "ignore" });
      return 0;
    } catch (error) {
      return typeof error?.status === "number" ? error.status : null;
    }
  };
  const unchecked = { ignored: null, tracked: null, checked: false };
  if (!envFile) return unchecked;
  if (run(["rev-parse", "--is-inside-work-tree"]) !== 0) return unchecked;
  const target = resolve(envFile);
  const ignored = run(["check-ignore", "-q", "--", target]);
  const tracked = run(["ls-files", "--error-unmatch", "--", target]);
  return {
    ignored: ignored === 0 ? true : ignored === 1 ? false : null,
    tracked: tracked === 0 ? true : tracked === null ? null : false,
    checked: true,
  };
}

const safely = (compute, fallback) => {
  try {
    return compute() ?? fallback;
  } catch {
    return fallback;
  }
};

const entrypoints = safely(() => findEntrypoints(appDir), []);

// Several candidates and no --dir means the working directory is not the app.
// Its scripts start something else and its environment file is not the one the
// app reads, so answering either would be a confident wrong answer: the
// monorepo case where a root `pnpm dev` starts the marketing site and a root
// `.env` that does not exist gets a clean safety verdict. Both degrade to null
// and the note says how to get the real ones.
const unresolved = !dir && apps.length > 1;
const restart = unresolved ? null : safely(() => detectRestart(appDir, entrypoints), null);
const envFile = unresolved ? null : safely(() => describeEnvFile(detectEnvFile(appDir)), null);
const envFileSafe = safely(() => checkEnvFileSafety(appDir, envFile?.path), {
  ignored: null,
  tracked: null,
  checked: false,
});
const note = unresolved
  ? `${apps.length} app candidates and no --dir, so restart and env_file are not reported. Re-run with --dir <app>.`
  : null;

const nothingRead = seen.length === 0;
const result = {
  route: verdict?.route ?? 5,
  framework: nothingRead ? "no manifests found" : (verdict?.framework ?? "none recognized"),
  evidence,
  app: appDir,
  apps,
  entrypoints,
  restart,
  env_file: envFile,
  env_file_safe: envFileSafe,
  note,
};

if (nothingRead) {
  if (!dir && apps.length > 1) {
    console.error(
      `warning: ${apps.length} app candidates and no --dir, so nothing was read. Re-run with --dir <path>.`,
    );
  } else {
    console.error(`warning: no ${MANIFESTS.join(", ")} under "${appDir}". Check --dir.`);
  }
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

  console.log(`\napp: ${appDir}`);
  if (!dir && apps.length > 1) {
    console.log(`  candidates, pick one with --dir: ${apps.join(", ")}`);
  }
  console.log(`entrypoints: ${entrypoints.length > 0 ? entrypoints.join(", ") : "none found"}`);
  console.log(`restart: ${restart ? `${restart.command} (${restart.source})` : "unknown"}`);
  if (restart?.note) console.log(`  ${restart.note}`);
  if (envFile) {
    const safety = !envFileSafe.checked
      ? "git did not answer, check by hand"
      : `${envFileSafe.ignored ? "ignored" : "NOT ignored"}, ${envFileSafe.tracked ? "TRACKED, untrack it" : "untracked"}`;
    const there = envFile.exists ? "" : ", does not exist yet";
    console.log(`env file: ${envFile.path} (${envFile.reason})${there}, ${safety}`);
  } else {
    console.log("env file: unknown");
  }
  if (note) console.log(note);

  if (!nothingRead) {
    console.log("\nA manifest entry is not proof spans are emitted. Confirm at the entrypoint.");
  }
}

if (nothingRead) process.exit(1);
