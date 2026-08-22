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

const WORKSPACE_FILES = ["pnpm-workspace.yaml", "pnpm-workspace.yml"];

function yamlScalar(value) {
  let scalar = value.trim().replace(/\s+#.*$/, "");
  if (
    scalar.length >= 2 &&
    ((scalar.startsWith('"') && scalar.endsWith('"')) ||
      (scalar.startsWith("'") && scalar.endsWith("'")))
  ) {
    scalar = scalar.slice(1, -1);
  }
  return scalar;
}

/** Split an inline YAML sequence body on commas that sit outside quotes and
 *  braces, so `"products/{a,b}/*", "demo/*"` stays two patterns. */
function splitInlineSequence(body) {
  const items = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current);
  return items;
}

/** Declared pnpm workspace members, read without pulling in a YAML parser. */
function pnpmWorkspacePatterns(path) {
  const patterns = [];
  for (const file of WORKSPACE_FILES) {
    const raw = readText(join(path, file));
    if (!raw) continue;
    let packagesIndent = null;
    for (const line of raw.split("\n")) {
      const header = line.match(/^(\s*)packages\s*:\s*(.*?)\s*$/);
      if (header) {
        packagesIndent = header[1].length;
        const inline = header[2].replace(/\s+#.*$/, "").trim();
        if (inline.startsWith("[") && inline.endsWith("]")) {
          patterns.push(...splitInlineSequence(inline.slice(1, -1)).map(yamlScalar));
        }
        continue;
      }
      if (packagesIndent === null || !line.trim() || line.trimStart().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= packagesIndent) {
        packagesIndent = null;
        continue;
      }
      const item = line.trim().match(/^-\s+(.+)$/);
      if (item) patterns.push(yamlScalar(item[1]));
    }
  }
  return patterns;
}

/** Workspace member globs declared by npm or pnpm, including exclusions. */
function workspaceMemberPatterns(path) {
  const pkg = readJson(join(path, NODE_MANIFEST));
  const npmPatterns = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages)
      ? pkg.workspaces.packages
      : [];
  return [...new Set([...npmPatterns, ...pnpmWorkspacePatterns(path)])]
    .map((pattern) => (typeof pattern === "string" ? pattern.trim() : ""))
    .filter(Boolean);
}

const workspacePath = (path) => path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");

function workspaceSegmentRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      source += ".*";
      continue;
    }
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) return null;
      let members = pattern.slice(index + 1, end);
      const negated = members.startsWith("!") || members.startsWith("^");
      if (negated) members = members.slice(1);
      if (!members || members.includes("[")) return null;
      source += `[${negated ? "^" : ""}${members.replaceAll("\\", "\\\\")}]`;
      index = end;
      continue;
    }
    if (character === "]") return null;
    source += character.replace(/[.+?^${}()|\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

function workspaceSegmentMatches(pattern, value) {
  return workspaceSegmentRegex(pattern)?.test(value) ?? false;
}

function expandWorkspaceBraces(pattern) {
  const match = pattern.match(/\{([^{}]*,[^{}]*)\}/);
  if (!match) return [pattern];
  return match[1].split(",").flatMap((alternative) =>
    expandWorkspaceBraces(pattern.replace(match[0], alternative)),
  );
}

function supportedWorkspacePattern(pattern) {
  const candidate = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  const outsideClasses = candidate.replace(/\[[^\]]*\]/g, "");
  if (/[?+@*!]\(/.test(outsideClasses) || outsideClasses.includes("?")) return false;
  const expanded = expandWorkspaceBraces(candidate);
  if (expanded.some((item) => item.includes("{") || item.includes("}"))) return false;
  return expanded.every((item) =>
    workspacePath(item)
      .split("/")
      .every((segment) => segment === "**" || workspaceSegmentRegex(segment) !== null),
  );
}

/** Match workspace globs where `*` stays in one segment and `**` crosses directories. */
function matchesWorkspacePattern(pattern, candidate) {
  const expected = workspacePath(pattern).split("/");
  const actual = workspacePath(candidate).split("/");
  const matches = (patternIndex, candidateIndex) => {
    if (patternIndex === expected.length) return candidateIndex === actual.length;
    if (expected[patternIndex] === "**") {
      return (
        matches(patternIndex + 1, candidateIndex) ||
        (candidateIndex < actual.length && matches(patternIndex, candidateIndex + 1))
      );
    }
    return (
      candidateIndex < actual.length &&
      workspaceSegmentMatches(expected[patternIndex], actual[candidateIndex]) &&
      matches(patternIndex + 1, candidateIndex + 1)
    );
  };
  return matches(0, 0);
}

function isDeclaredWorkspaceMember(patterns, candidate) {
  const included = patterns.some(
    (pattern) => !pattern.startsWith("!") && matchesWorkspacePattern(pattern, candidate),
  );
  const excluded = patterns.some(
    (pattern) => pattern.startsWith("!") && matchesWorkspacePattern(pattern.slice(1), candidate),
  );
  return included && !excluded;
}

function isExcludedWorkspaceMember(patterns, candidate) {
  return (
    patterns.some(
      (pattern) => !pattern.startsWith("!") && matchesWorkspacePattern(pattern, candidate),
    ) &&
    patterns.some(
      (pattern) => pattern.startsWith("!") && matchesWorkspacePattern(pattern.slice(1), candidate),
    )
  );
}

/** Expand declared workspace members without relying on the shallow app scan.
 *  A double star is bounded to four directories so an overly broad workspace
 *  declaration cannot turn detection into a full repository crawl. */
function workspaceMemberDirectories(root, patterns) {
  const found = new Set();
  let truncated = false;
  const walk = (path, segments, index, depth = 0) => {
    if (index === segments.length) {
      const candidate = relative(root, path).split(sep).join("/");
      if (isApp(path) && isDeclaredWorkspaceMember(patterns, candidate)) found.add(path);
      return;
    }

    const segment = segments[index];
    if (segment === "**") {
      walk(path, segments, index + 1);
      const nested = subdirectories(path);
      if (depth >= 4) {
        if (nested.length > 0) truncated = true;
        return;
      }
      for (const name of nested) {
        walk(join(path, name), segments, index, depth + 1);
      }
      return;
    }

    if (segment.includes("*") || segment.includes("[")) {
      for (const name of subdirectories(path)) {
        if (workspaceSegmentMatches(segment, name)) {
          walk(join(path, name), segments, index + 1);
        }
      }
      return;
    }

    if (skipped(segment)) return;
    const next = join(path, segment);
    try {
      if (statSync(next).isDirectory()) walk(next, segments, index + 1);
    } catch {
      // A missing literal segment means this pattern has no matches.
    }
  };

  for (const pattern of patterns.filter((candidate) => !candidate.startsWith("!"))) {
    const segments = workspacePath(pattern).split("/").filter((segment) => segment && segment !== ".");
    walk(root, segments, 0);
  }
  return { directories: [...found].sort(), truncated };
}

// Ordered lightest route first: the first rung that matches wins, because the
// ladder's whole point is to add as little as possible.
//
// The named frameworks come before the generic rungs, and that ordering is the
// deliberate part. A framework that speaks OpenTelemetry itself (Pydantic AI,
// Mastra, Spectrum-TS) or has a published instrumentor of its own (Agno,
// CrewAI, DSPy) has a recipe that is strictly more specific than "an
// OpenTelemetry package is declared here", and in most of these apps that
// package is the framework's own dependency rather than an exporter the
// customer set up: CrewAI pins the OTel SDK, Pydantic AI requires the API,
// Mastra and Spectrum-TS both ship exporters built on it. Going the other way,
// a real existing exporter is never hidden by this, because every matching rung
// still contributes its evidence line: a Mastra verdict arrives with the
// "existing OpenTelemetry" evidence beside it, and the skill's route 1 text
// says to keep that backend and add Buildbox next to it. LangChain stays below
// the generic rung, where it already was, because route 1's own text is written
// around that case.
//
// `hint` is the one-line next step for the text output; a rung without one
// falls back to the note for its route number.
const RUNGS = [
  {
    route: 1,
    framework: "Pydantic AI",
    node: [],
    // `pydantic-ai` is the meta-package and depends on `pydantic-ai-slim`.
    python: ["pydantic-ai", "pydantic-ai-slim"],
    hint:
      "Pydantic AI emits OpenTelemetry itself. Add a provider if none runs, call " +
      "Agent.instrument_all(), then use the applicable exporter path. Check that runs are passed a " +
      "conversation_id.",
  },
  {
    route: 1,
    framework: "Mastra",
    // `@mastra/core` is the library; the bare `mastra` package is the CLI.
    node: ["@mastra/", "mastra"],
    verdictNode: ["@mastra/core"],
    python: [],
    hint:
      "Mastra exports through @mastra/otel-exporter in its own observability config. Endpoint " +
      "and header are set in code, so use the dedicated BUILDBOX_OTLP_TRACES_* pair.",
  },
  {
    route: 1,
    framework: "Spectrum-TS",
    // Adobe's @react-spectrum/* and @spectrum-icons/* are a UI library, not this.
    node: ["spectrum-ts", "@spectrum-ts/"],
    python: [],
    hint:
      "Keep Spectrum's scoped vendor telemetry, start an app-global NodeSDK with the dedicated " +
      "Buildbox exporter, and instrument the actual model client.",
  },
  {
    route: 3,
    framework: "Agno",
    node: [],
    python: ["agno"],
    hint:
      "Register AgnoInstrumentor at startup, then use the applicable exporter path. " +
      "setup_tracing() writes to a database, it is not an OTLP route.",
  },
  {
    route: 3,
    framework: "CrewAI",
    node: [],
    // `crewai-core` and `crewai-cli` share the pin; `crewai-tools` is separate.
    python: ["crewai", "crewai-"],
    verdictPython: ["crewai"],
    hint:
      "Register CrewAIInstrumentor and the active LLM client's instrumentor at startup, then " +
      "add the applicable exporter path. Let OTel resolve inside CrewAI's ~=1.42 pin.",
  },
  {
    route: 3,
    framework: "DSPy",
    node: [],
    // `dspy-ai` is a compatibility alias for `dspy` at the same version.
    python: ["dspy", "dspy-ai"],
    hint:
      "Register DSPyInstrumentor at startup, then use the applicable exporter path. Optimizer " +
      "runs trace every candidate against every example, so start with the serving path.",
  },
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

/** Split a shell command into tokens, keeping a quoted string as one token so
 *  a flag inside `npx -c "tsx -w src/index.ts"` belongs to the quoted child
 *  command, not to npx. */
function shellTokens(text) {
  const tokens = [];
  let current = "";
  let quote = null;
  let pending = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      pending = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      pending = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (pending) tokens.push(current);
      current = "";
      pending = false;
      continue;
    }
    current += ch;
    pending = true;
  }
  if (pending) tokens.push(current);
  return tokens;
}

/** Does a pnpm `--filter` selector name the root package itself? */
function selectsRoot(selector, rootName) {
  if (selector === "." || selector === "{.}") return true;
  return rootName !== null && selector === rootName;
}

function delegatesToWorkspaceMember(command, rootName = null) {
  return command
    .split(/&&|;|\|\|/)
    .filter((segment) => segment.trim())
    .every((segment) => {
      const tokens = shellTokens(segment.trim());
      // Leading `KEY=value` assignments set the environment for the command
      // that follows; the tool is the first token that is not one.
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
      const [tool] = tokens;
      const args = tokens.slice(1);
      if (tool === "pnpm") {
        const valued = new Set([
          "--dir",
          "-C",
          "--loglevel",
          "--reporter",
          "--store-dir",
          "--virtual-store-dir",
        ]);
        // Read pnpm's whole option region before deciding: a root selector
        // (`--filter .`, the root's own name) anywhere in it means the root
        // runs, even beside `-r`.
        let scoped = false;
        for (let i = 0; i < args.length; i += 1) {
          const token = args[i];
          if (token === "--" || !token.startsWith("-")) break;
          if (token === "--filter" || token === "-F") {
            if (selectsRoot(args[i + 1] ?? "", rootName)) return false;
            scoped = true;
            i += 1;
            continue;
          }
          if (token.startsWith("--filter=") || token.startsWith("-F=")) {
            if (selectsRoot(token.slice(token.indexOf("=") + 1), rootName)) return false;
            scoped = true;
            continue;
          }
          if (token === "-r" || token === "--recursive") scoped = true;
          if (valued.has(token) || (token.startsWith("--config.") && !token.includes("="))) {
            i += 1;
          }
        }
        return scoped;
      }
      if (tool === "npm") {
        const flags = new Set(["--workspace", "--workspaces", "-w", "-ws"]);
        // `--include-workspace-root` runs the script in the root project too,
        // so the root is launched and stays a candidate.
        const scope = [];
        for (const token of args) {
          if (token === "--") break;
          scope.push(token);
        }
        if (scope.includes("--include-workspace-root")) return false;
        for (let i = 0; i < scope.length; i += 1) {
          const token = scope[i];
          const selector =
            token === "--workspace" || token === "-w"
              ? (scope[i + 1] ?? "")
              : token.startsWith("--workspace=")
                ? token.slice("--workspace=".length)
                : null;
          // A workspace selector naming the root package launches the root.
          if (selector !== null && selectsRoot(selector, rootName)) return false;
        }
        return scope.some((token) => flags.has(token) || token.startsWith("--workspace="));
      }
      if (tool === "npx") {
        const flags = new Set(["--workspace", "--workspaces", "-w", "-ws"]);
        // npx options that take a value: the next token is the value, not the
        // executable, so the scan continues past it.
        const valued = new Set([
          "--registry",
          "--loglevel",
          "--cache",
          "--prefix",
          "--userconfig",
          "--package",
          "-p",
          "--call",
          "-c",
          "--shell",
          "--shell-auth",
          "--npm",
          "--node-arg",
          "-n",
        ]);
        for (let i = 0; i < args.length; i++) {
          const token = args[i];
          if (token === "--" || !token.startsWith("-")) return false;
          if (token === "--workspace" || token === "-w") {
            // A selector naming the root package launches the root.
            return !selectsRoot(args[i + 1] ?? "", rootName);
          }
          if (token.startsWith("--workspace=")) {
            return !selectsRoot(token.slice("--workspace=".length), rootName);
          }
          if (flags.has(token)) return true;
          if (valued.has(token)) i += 1;
        }
        return false;
      }
      if (tool === "yarn") return tokens[1] === "workspace" || tokens[1] === "workspaces";
      return new Set(["turbo", "lerna", "nx", "wsrun", "moon"]).has(tool);
    });
}

/** Is this directory a workspace root rather than an app of its own? Its
 *  manifest declares member packages, carries no runtime dependencies, and
 *  has no dev or start script that runs the app directly. A root that declares
 *  dependencies or runs its own app stays a candidate. Build tooling in
 *  `devDependencies` does not count, because a model client is a runtime
 *  dependency. A Python manifest at the root does, because this only reads the
 *  Node one. */
function bareWorkspaceRoot(path) {
  if (PYTHON_MANIFESTS.some((name) => exists(join(path, name)))) return false;
  const pkg = readJson(join(path, NODE_MANIFEST));
  if (!pkg) return false;
  const declaresMembers =
    pkg.workspaces !== undefined || WORKSPACE_FILES.some((name) => exists(join(path, name)));
  // A root is bare only when it carries nothing that could be the app: no
  // runtime, peer or optional dependency at all, and no model client among its
  // dev dependencies. Build tooling under devDependencies (typescript, eslint)
  // is what every monorepo root has and does not make the root an app; a client
  // SDK declared there does, which keeps this in step with what nodePackages()
  // reads as route evidence.
  const runtime = ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((group) =>
    Object.keys(pkg?.[group] ?? {}),
  );
  const dev = Object.keys(pkg?.devDependencies ?? {});
  const devClient = RUNGS.some((rung) => hits(dev, rung.node).length > 0);
  const runsOwnApp = [pkg.scripts?.dev, pkg.scripts?.start].some(
    (command) =>
      typeof command === "string" &&
      command.trim() &&
      !delegatesToWorkspaceMember(command, typeof pkg.name === "string" ? pkg.name : null),
  );
  return declaresMembers && runtime.length === 0 && !devClient && !runsOwnApp;
}

/** Every directory with a dependency manifest, at the working directory and one
 *  and two levels under it. Two levels reaches `apps/web` and `services/api`
 *  without walking a whole monorepo. */
let workspacePatternsUnmatched = false;
let workspaceScanTruncated = false;
let workspacePatternsUnsupported = false;
let workspaceMemberNote = null;

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
  const declaredPatterns = workspaceMemberPatterns(root);
  const unsupportedPatterns = declaredPatterns.filter(
    (pattern) => !supportedWorkspacePattern(pattern),
  );
  const patterns = declaredPatterns
    .filter(supportedWorkspacePattern)
    .flatMap(expandWorkspaceBraces);
  workspacePatternsUnsupported = unsupportedPatterns.length > 0;
  for (let index = found.length - 1; index >= 0; index -= 1) {
    if (found[index] === join(root)) continue;
    const candidate = relative(root, found[index]).split(sep).join("/");
    if (isExcludedWorkspaceMember(patterns, candidate)) found.splice(index, 1);
  }
  const { directories: declaredMembers, truncated } = workspaceMemberDirectories(root, patterns);
  workspaceScanTruncated = truncated;
  for (const member of declaredMembers) {
    if (!found.includes(member)) found.push(member);
  }

  if (workspacePatternsUnsupported) {
    workspaceMemberNote =
      `Declared member patterns use unsupported glob syntax: ${unsupportedPatterns.join(", ")}. ` +
      "The workspace root remains a candidate and is not settled. Re-run with --dir <app>.";
  } else if (truncated) {
    workspaceMemberNote =
      "A declared member pattern reaches deeper than the scan's four-directory limit. " +
      "The workspace root remains a candidate and is not settled. Re-run with --dir <app>.";
  } else if (patterns.length > 0 && declaredMembers.length === 0) {
    workspacePatternsUnmatched = true;
    workspaceMemberNote =
      `Declared member patterns matched no directory with a manifest: ${patterns.join(", ")}. ` +
      "The workspace root remains a candidate but is not settled.";
  }

  // Once a declared member has been found, drop a root that is only a
  // workspace root. An unrelated manifest is not evidence that the scan found
  // a member, especially when the member glob reaches below this two-level scan.
  if (found[0] === join(root) && bareWorkspaceRoot(root)) {
    const memberFound = found.slice(1).some((path) => {
      const candidate = relative(root, path).split(sep).join("/");
      return isDeclaredWorkspaceMember(patterns, candidate);
    });
    if (memberFound && !truncated && !workspacePatternsUnsupported) found.shift();
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

const evidence = [];
let verdict = null;
for (const rung of RUNGS) {
  const found = [...hits(nodeDeps, rung.node), ...hits(pyDeps, rung.python)];
  if (found.length === 0) continue;
  for (const name of new Set(found)) evidence.push(`${rung.framework}: ${name}`);
  const verdictFound = [
    ...hits(nodeDeps, rung.verdictNode ?? rung.node),
    ...hits(pyDeps, rung.verdictPython ?? rung.python),
  ];
  if (!verdict && verdictFound.length > 0) verdict = rung;
}

// ---------------------------------------------------------------------------
// Entrypoints: the files that import a model client or an agent framework.
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".py"];
// Manifest evidence intentionally accepts companion packages, but an entrypoint
// must import the runtime itself. Otherwise exporter and config files become the
// suggested place to add instrumentation.
const ENTRYPOINT_MODEL_MODULES = [
  "ai",
  "openai",
  "@anthropic-ai/sdk",
  "anthropic",
  "langchain",
  "@langchain/",
  "langgraph",
  "@openai/agents",
  "openai-agents",
  "@mastra/core",
  "spectrum-ts",
  "@spectrum-ts/core",
];
// Python imports the distributions above under these top-level module names.
// `pydantic_ai` is listed whole: plain `pydantic` is a validation library that
// half the ecosystem imports and it says nothing about model calls.
const PYTHON_ENTRYPOINT_MODEL_MODULES = [
  "openai",
  "anthropic",
  "langchain",
  "langgraph",
  "agents",
  "agno",
  "crewai",
  "dspy",
  "pydantic_ai",
];
const WHOLE_PYTHON_ENTRYPOINT_MODULES = new Set(["agno", "crewai", "dspy", "pydantic_ai"]);

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
      const hit = ENTRYPOINT_MODEL_MODULES.some((name) =>
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
    return PYTHON_ENTRYPOINT_MODEL_MODULES.some((name) =>
      WHOLE_PYTHON_ENTRYPOINT_MODULES.has(name)
        ? root === name
        : root === name || root.startsWith(`${name}_`),
    );
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
// `.env` that does not exist gets a clean safety verdict. The route goes the
// same way, and it is the expensive one: route 5 means "write manual spans by
// hand", and a route read off a root manifest is a route for a directory that
// does not call a model. All four degrade to null or "undetermined" and the
// note says how to get the real ones. The evidence stays, because every match
// found is still a fact about what was read.
const multipleCandidates = !dir && apps.length > 1;
const unresolvedWorkspace =
  !dir && (workspacePatternsUnmatched || workspaceScanTruncated || workspacePatternsUnsupported);
const unresolved = multipleCandidates || unresolvedWorkspace;
const restart = unresolved ? null : safely(() => detectRestart(appDir, entrypoints), null);
const envFile = unresolved ? null : safely(() => describeEnvFile(detectEnvFile(appDir)), null);
const envFileSafe = safely(() => checkEnvFileSafety(appDir, envFile?.path), {
  ignored: null,
  tracked: null,
  checked: false,
});
const unresolvedNote = multipleCandidates
  ? `${apps.length} app candidates and no --dir, so route, framework, restart and env_file are not reported. Re-run with --dir <app>.`
  : null;
const note = [unresolvedNote, workspaceMemberNote].filter(Boolean).join(" ") || null;

const nothingRead = seen.length === 0;
const result = {
  route: unresolved ? null : (verdict?.route ?? 5),
  framework: unresolved
    ? "undetermined"
    : nothingRead
      ? "no manifests found"
      : (verdict?.framework ?? "none recognized"),
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
  if (multipleCandidates) {
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
  if (multipleCandidates) {
    console.log(`route: undetermined, ${apps.length} app candidates and no --dir`);
    console.log(
      "Nothing was ruled out. The route belongs to the app that calls the model, not to the " +
        "repo root, so re-run with --dir <app> before changing anything.",
    );
  } else if (unresolvedWorkspace) {
    console.log(
      workspaceScanTruncated
        ? "route: undetermined, workspace member scan incomplete"
        : workspacePatternsUnsupported
          ? "route: undetermined, workspace member pattern unsupported"
          : "route: undetermined, declared workspace members not found",
    );
    console.log(
      workspaceScanTruncated
        ? "A declared member pattern reaches deeper than the scan, so the workspace root is not settled."
        : workspacePatternsUnsupported
          ? "A declared member pattern uses unsupported glob syntax, so the workspace root is not settled."
          : "The declared member patterns matched no directory with a manifest, so the workspace " +
              "root is not settled.",
    );
  } else {
    console.log(`route ${result.route}: ${result.framework}`);
    console.log(
      nothingRead
        ? "Nothing was read, so nothing was ruled out. Point --dir at the app that talks to the model."
        : (verdict?.hint ?? NOTES[result.route]),
    );
  }
  if (evidence.length > 0) {
    console.log("\nevidence:");
    for (const item of evidence) console.log(`  ${item}`);
  }

  console.log(`\napp: ${appDir}`);
  if (multipleCandidates) {
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
