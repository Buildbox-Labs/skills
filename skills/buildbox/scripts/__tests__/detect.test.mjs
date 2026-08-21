import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DETECT = join(dirname(fileURLToPath(import.meta.url)), "..", "detect.mjs");

function detect(args, cwd) {
  const result = spawnSync(process.execPath, [DETECT, ...args], { cwd, encoding: "utf8" });
  return { ...result, json: () => JSON.parse(result.stdout) };
}

/** A throwaway app tree. Keys are paths, values are file contents. */
function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "buildbox-detect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

const NEXT_APP = {
  "package.json": JSON.stringify({
    name: "web",
    scripts: { dev: "next dev", build: "next build" },
    dependencies: { next: "15.0.0", ai: "^4.0.0" },
  }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "app/api/chat/route.ts": 'import { streamText } from "ai";\nexport async function POST() {}\n',
  "app/page.tsx": "export default function Page() { return null; }\n",
  "node_modules/ai/index.js": 'export { streamText } from "ai";\n',
};

const PYTHON_APP = {
  "pyproject.toml": [
    "[project]",
    'name = "agent"',
    'dependencies = ["langchain-core>=0.3", "langgraph>=0.2"]',
    "",
    "[project.scripts]",
    'agent = "agent.main:main"',
    "",
  ].join("\n"),
  "main.py": "from langchain_core.messages import HumanMessage\n\nprint(HumanMessage)\n",
  "helpers.py": "import json\n",
};

test("reports route, entrypoints, restart and env file for a Next.js app using the AI SDK", (t) => {
  const root = fixture(t, NEXT_APP);
  const result = detect(["--dir", root, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = result.json();
  assert.equal(report.route, 2);
  assert.equal(report.framework, "Vercel AI SDK");
  assert.deepEqual(report.apps, [root]);
  assert.equal(report.app, root);
  assert.deepEqual(report.entrypoints, [join(root, "app/api/chat/route.ts")]);
  assert.deepEqual(report.restart, {
    command: "pnpm dev",
    source: "package.json scripts.dev",
  });
  assert.equal(report.env_file.path, join(root, ".env.local"));
  assert.match(report.env_file.reason, /Next\.js/);
  assert.deepEqual(Object.keys(report.env_file_safe).sort(), ["checked", "ignored", "tracked"]);
});

test("reports route, entrypoints and env file for a Python LangChain app", (t) => {
  const root = fixture(t, PYTHON_APP);
  const result = detect(["--dir", root, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = result.json();
  assert.equal(report.route, 3);
  assert.equal(report.framework, "LangChain / LangGraph");
  assert.deepEqual(report.entrypoints, [join(root, "main.py")]);
  assert.deepEqual(report.restart, {
    command: "agent",
    source: "pyproject.toml [project.scripts]",
  });
  assert.equal(report.env_file.path, join(root, ".env"));
  assert.equal(report.env_file.reason, "dotenv default");
});

test("reads the restart command from a Dockerfile and the env file from compose", (t) => {
  const root = fixture(t, {
    "requirements.txt": "openai==1.40.0\n",
    "Dockerfile": 'FROM python:3.12\nCMD ["uvicorn", "app:app", "--host", "0.0.0.0"]\n',
    "docker-compose.yml": "services:\n  api:\n    env_file:\n      - .env.docker\n",
    "app.py": "from openai import OpenAI\n",
  });
  const result = detect(["--dir", root, "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const report = result.json();
  assert.equal(report.route, 4);
  assert.deepEqual(report.restart, {
    command: "uvicorn app:app --host 0.0.0.0",
    source: "Dockerfile CMD",
  });
  assert.equal(report.env_file.path, join(root, ".env.docker"));
  assert.match(report.env_file.reason, /env_file/);
  assert.deepEqual(report.entrypoints, [join(root, "app.py")]);
});

test("without --dir, a single candidate settles the app directory", (t) => {
  const root = fixture(t, {
    "apps/agent/package.json": JSON.stringify({ dependencies: { openai: "^4.0.0" } }),
    "apps/agent/index.mjs": 'import OpenAI from "openai";\n',
  });
  const result = detect(["--json"], root);

  assert.equal(result.status, 0, result.stderr);
  const report = result.json();
  assert.deepEqual(report.apps, ["apps/agent"]);
  assert.equal(report.app, "apps/agent");
  assert.equal(report.route, 4);
  assert.deepEqual(report.entrypoints, [join("apps/agent", "index.mjs")]);
});

test("without --dir, two candidates are reported for one batched question", (t) => {
  const root = fixture(t, {
    "apps/web/package.json": JSON.stringify({ dependencies: { ai: "^4.0.0" } }),
    "services/api/pyproject.toml": '[project]\nname = "api"\n',
    "node_modules/vendor/package.json": "{}",
  });
  const result = detect(["--json"], root);

  const report = result.json();
  assert.deepEqual(report.apps, ["apps/web", "services/api"]);
  assert.equal(report.app, ".");
  assert.match(result.stderr, /2 app candidates/);
  assert.equal(result.status, 1);
});

test("a monorepo root reports no restart and no env file, with a note naming --dir", (t) => {
  // The root script starts the wrong app and the root .env is not the file the
  // API reads, so both have to come back empty rather than plausible.
  const root = fixture(t, {
    "package.json": JSON.stringify({ scripts: { dev: "pnpm --filter web dev" } }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "apps/web/package.json": JSON.stringify({ scripts: { dev: "next dev" } }),
    "apps/api/package.json": JSON.stringify({
      scripts: { dev: "node server.mjs" },
      dependencies: { openai: "^4.0.0" },
    }),
    "apps/api/server.mjs": 'import OpenAI from "openai";\n',
  });
  const result = detect(["--json"], root);

  const report = result.json();
  assert.ok(report.apps.length > 1, `apps: ${report.apps.join(", ")}`);
  assert.equal(report.restart, null);
  assert.equal(report.env_file, null);
  assert.match(report.note, /--dir/);
  assert.deepEqual(report.env_file_safe, { ignored: null, tracked: null, checked: false });

  // The same tree with --dir answers both, which is what the note asks for.
  const scoped = detect(["--dir", join(root, "apps/api"), "--json"], root).json();
  assert.equal(scoped.note, null);
  assert.deepEqual(scoped.restart, {
    command: "npm run dev",
    source: "package.json scripts.dev",
  });
  assert.equal(scoped.env_file.path, join(root, "apps/api", ".env"));
});

test("an env file that is not there yet says so and is still checked against git", (t) => {
  const root = fixture(t, { "package.json": "{}", ".gitignore": ".env\n" });
  if (git(["init", "-q"], root).status !== 0) {
    t.skip("git is not available");
    return;
  }

  const missing = detect(["--dir", root, "--json"]).json();
  assert.equal(missing.env_file.exists, false);
  assert.equal(missing.env_file.note, "file does not exist yet");
  assert.deepEqual(missing.env_file_safe, { ignored: true, tracked: false, checked: true });

  writeFileSync(join(root, ".env"), "OTHER=keep\n");
  const present = detect(["--dir", root, "--json"]).json();
  assert.equal(present.env_file.exists, true);
  assert.equal(present.env_file.note, undefined);
});

test("infers a uvicorn restart from a FastAPI entrypoint when nothing wrote one down", (t) => {
  const root = fixture(t, {
    "requirements.txt": "fastapi==0.115.0\nopenai==1.40.0\nuvicorn[standard]==0.30.0\n",
    "README.md": "# api\n\nInstall the requirements, then run it.\n",
    "app.py": [
      "from fastapi import FastAPI",
      "from openai import OpenAI",
      "",
      "app = FastAPI()",
      "",
      'if __name__ == "__main__":',
      "    import uvicorn",
      '    uvicorn.run(app, host="0.0.0.0", port=8080)',
      "",
    ].join("\n"),
  });
  const report = detect(["--dir", root, "--json"]).json();

  assert.deepEqual(report.restart, {
    command: "uvicorn app:app --port 8080",
    source: "inferred from FastAPI entrypoint",
  });
});

test("a uvicorn line in the README beats the inference, and a Dockerfile CMD beats both", (t) => {
  const files = {
    "requirements.txt": "fastapi==0.115.0\n",
    "README.md": "## Run\n\n```bash\nuvicorn app:api --reload --port 9001\n```\n",
    "app.py": "from fastapi import FastAPI\n\napi = FastAPI()\n",
  };
  const readme = detect(["--dir", fixture(t, files), "--json"]).json();
  assert.deepEqual(readme.restart, {
    command: "uvicorn app:api --reload --port 9001",
    source: "README.md (uvicorn)",
  });

  const dockerised = fixture(t, {
    ...files,
    "Dockerfile": 'FROM python:3.12\nCMD ["uvicorn", "app:api", "--host", "0.0.0.0"]\n',
  });
  assert.deepEqual(detect(["--dir", dockerised, "--json"]).json().restart, {
    command: "uvicorn app:api --host 0.0.0.0",
    source: "Dockerfile CMD",
  });
});

test("a package entrypoint infers the package, not its __init__ module", (t) => {
  const root = fixture(t, {
    "requirements.txt": "fastapi==0.115.0\nopenai==1.40.0\n",
    "api/__init__.py": [
      "from fastapi import FastAPI",
      "from openai import OpenAI",
      "",
      "app = FastAPI()",
      "",
    ].join("\n"),
  });

  assert.deepEqual(detect(["--dir", root, "--json"]).json().restart, {
    command: "uvicorn api:app",
    source: "inferred from FastAPI entrypoint",
  });
});

test("a directory Python cannot import is not turned into a module path", (t) => {
  const root = fixture(t, {
    "requirements.txt": "fastapi==0.115.0\nopenai==1.40.0\n",
    "my-service/main.py": [
      "from fastapi import FastAPI",
      "from openai import OpenAI",
      "",
      "app = FastAPI()",
      "",
    ].join("\n"),
  });

  // `uvicorn my-service.main:app` is not a command, it is a syntax error at
  // import time, so the report says unknown and the note asks for the real one.
  assert.equal(detect(["--dir", root, "--json"]).json().restart, null);
});

test("a src layout keeps the inferred command and notes that it may need --app-dir", (t) => {
  const root = fixture(t, {
    "requirements.txt": "fastapi==0.115.0\nopenai==1.40.0\n",
    "src/api/main.py": [
      "from fastapi import FastAPI",
      "from openai import OpenAI",
      "",
      "app = FastAPI()",
      "",
    ].join("\n"),
  });
  const restart = detect(["--dir", root, "--json"]).json().restart;

  assert.equal(restart.command, "uvicorn src.api.main:app");
  assert.equal(restart.source, "inferred from FastAPI entrypoint");
  assert.match(restart.note, /--app-dir src/);
  assert.match(restart.note, /api\.main:app/);
});

test("a uvicorn dependency pin is not read back as a restart command", (t) => {
  const root = fixture(t, {
    "pyproject.toml": '[project]\nname = "api"\ndependencies = ["uvicorn[standard]>=0.30"]\n',
    "helpers.py": "import json\n",
  });

  assert.equal(detect(["--dir", root, "--json"]).json().restart, null);
});

test("env_file_safe answers from git, and says so when there is no repository", (t) => {
  const outsideRepo = fixture(t, { "package.json": "{}" });
  if (git(["rev-parse", "--is-inside-work-tree"], outsideRepo).status === 0) {
    t.skip("the temp directory is inside a git repository");
    return;
  }
  assert.deepEqual(detect(["--dir", outsideRepo, "--json"]).json().env_file_safe, {
    ignored: null,
    tracked: null,
    checked: false,
  });

  const repo = fixture(t, { "package.json": "{}", ".gitignore": ".env\n" });
  if (git(["init", "-q"], repo).status !== 0) {
    t.skip("git is not available");
    return;
  }
  assert.deepEqual(detect(["--dir", repo, "--json"]).json().env_file_safe, {
    ignored: true,
    tracked: false,
    checked: true,
  });

  // git stops treating a file as ignored once it is tracked, which is exactly
  // the state the skill has to catch and undo.
  writeFileSync(join(repo, ".env"), "OTHER=keep\n");
  git(["add", "-f", ".env"], repo);
  assert.deepEqual(detect(["--dir", repo, "--json"]).json().env_file_safe, {
    ignored: false,
    tracked: true,
    checked: true,
  });
});

test("the text output carries the app, entrypoints, restart and env file", (t) => {
  const root = fixture(t, NEXT_APP);
  const result = detect(["--dir", root]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^route 2: Vercel AI SDK$/m);
  assert.match(result.stdout, /^app: /m);
  assert.match(result.stdout, /^entrypoints: .*route\.ts$/m);
  assert.match(result.stdout, /^restart: pnpm dev \(package\.json scripts\.dev\)$/m);
  assert.match(result.stdout, /^env file: .*\.env\.local \(Next\.js reads \.env\.local\)/m);
});

test("a framework that speaks OTel itself wins over a coincidental OpenTelemetry package", (t) => {
  // The Mastra exporter is its own pipeline, so "some @opentelemetry package is
  // declared" is the less specific answer here. Both still show up as evidence.
  const root = fixture(t, {
    "package.json": JSON.stringify({
      name: "mastra-agent",
      dependencies: {
        "@mastra/core": "^1.61.0",
        "@mastra/observability": "^1.17.1",
        ai: "^7.0.0",
        "@opentelemetry/sdk-node": "^0.57.0",
      },
    }),
    "src/mastra.ts": 'import { Mastra } from "@mastra/core";\n',
  });
  const report = detect(["--dir", root, "--json"]).json();

  assert.equal(report.route, 1);
  assert.equal(report.framework, "Mastra");
  assert.ok(report.evidence.includes("Mastra: @mastra/core"), report.evidence.join(", "));
  assert.ok(
    report.evidence.includes("existing OpenTelemetry: @opentelemetry/sdk-node"),
    report.evidence.join(", "),
  );
  assert.deepEqual(report.entrypoints, [join(root, "src/mastra.ts")]);
});

test("Mastra CLI and companion packages are evidence but not a Mastra verdict without core", (t) => {
  const cliOnly = fixture(t, {
    "package.json": JSON.stringify({
      dependencies: { mastra: "^1.26.0", "@mastra/observability": "^1.17.1" },
    }),
  });
  const cliReport = detect(["--dir", cliOnly, "--json"]).json();
  assert.equal(cliReport.route, 5);
  assert.equal(cliReport.framework, "none recognized");
  assert.ok(cliReport.evidence.includes("Mastra: mastra"), cliReport.evidence.join(", "));
  assert.ok(
    cliReport.evidence.includes("Mastra: @mastra/observability"),
    cliReport.evidence.join(", "),
  );

  const mixed = fixture(t, {
    "package.json": JSON.stringify({ dependencies: { mastra: "^1.26.0", ai: "^7.0.0" } }),
  });
  const mixedReport = detect(["--dir", mixed, "--json"]).json();
  assert.equal(mixedReport.route, 2);
  assert.equal(mixedReport.framework, "Vercel AI SDK");
  assert.ok(mixedReport.evidence.includes("Mastra: mastra"), mixedReport.evidence.join(", "));
  assert.ok(
    mixedReport.evidence.includes("Vercel AI SDK: ai"),
    mixedReport.evidence.join(", "),
  );
});

test("entrypoints require framework runtime imports, not companion packages", (t) => {
  const root = fixture(t, {
    "package.json": JSON.stringify({
      dependencies: {
        "@mastra/core": "^1.61.0",
        "@mastra/observability": "^1.17.1",
        "@mastra/otel-exporter": "^1.4.0",
        mastra: "^1.26.0",
      },
    }),
    "requirements.txt": "crewai==1.15.17\ncrewai-tools==1.15.17\n",
    "crewai_runtime.py": "from crewai import Crew\n",
    "crewai_tools_only.py": "from crewai_tools import SerperDevTool\n",
    "src/mastra-cli.ts": 'import { defineConfig } from "mastra";\n',
    "src/mastra-observability.ts": [
      'import { Observability } from "@mastra/observability";',
      'import { OtelExporter } from "@mastra/otel-exporter";',
      "",
    ].join("\n"),
    "src/mastra-runtime.ts": 'import { Mastra } from "@mastra/core";\n',
  });

  const report = detect(["--dir", root, "--json"]).json();

  assert.deepEqual(report.entrypoints, [
    join(root, "crewai_runtime.py"),
    join(root, "src/mastra-runtime.ts"),
  ]);
});

test("Pydantic AI is route 1 under either distribution name", (t) => {
  const meta = fixture(t, {
    "pyproject.toml": '[project]\nname = "agent"\ndependencies = ["pydantic-ai==2.32.2"]\n',
    "main.py": "from pydantic_ai import Agent\n",
  });
  const metaReport = detect(["--dir", meta, "--json"]).json();
  assert.equal(metaReport.route, 1);
  assert.equal(metaReport.framework, "Pydantic AI");
  assert.deepEqual(metaReport.entrypoints, [join(meta, "main.py")]);

  const slim = fixture(t, {
    "requirements.txt": "pydantic-ai-slim[openai]==2.32.2\nopentelemetry-sdk==1.42.0\n",
  });
  const slimReport = detect(["--dir", slim, "--json"]).json();
  assert.equal(slimReport.framework, "Pydantic AI");
  assert.ok(
    slimReport.evidence.includes("Pydantic AI: pydantic-ai-slim"),
    slimReport.evidence.join(", "),
  );
});

test("Spectrum-TS matches its own scope and not Adobe's", (t) => {
  const spectrum = fixture(t, {
    "package.json": JSON.stringify({
      dependencies: { "@spectrum-ts/core": "^12.8.0", "@spectrum-ts/telegram": "^12.8.0" },
    }),
    "core.ts": 'import { Spectrum } from "@spectrum-ts/core";\n',
    "index.ts": 'import { Spectrum } from "spectrum-ts";\n',
    "telegram.ts": 'import { TelegramAdapter } from "@spectrum-ts/telegram";\n',
  });
  const report = detect(["--dir", spectrum, "--json"]).json();
  assert.equal(report.route, 1);
  assert.equal(report.framework, "Spectrum-TS");
  assert.deepEqual(report.entrypoints, [join(spectrum, "core.ts"), join(spectrum, "index.ts")]);

  const adobe = fixture(t, {
    "package.json": JSON.stringify({
      dependencies: { "@react-spectrum/table": "^3.0.0", "@spectrum-icons/workflow": "^4.0.0" },
    }),
  });
  const uiLibrary = detect(["--dir", adobe, "--json"]).json();
  assert.equal(uiLibrary.route, 5);
  assert.deepEqual(uiLibrary.evidence, []);
});

test("the OpenInference frameworks land on route 3 with their own next step", (t) => {
  const agno = fixture(t, {
    "requirements.txt": "agno[opentelemetry]==2.9.0\n",
    "app.py": "from agno.agent import Agent\n",
  });
  const agnoReport = detect(["--dir", agno, "--json"]).json();
  assert.equal(agnoReport.route, 3);
  assert.equal(agnoReport.framework, "Agno");
  assert.deepEqual(agnoReport.entrypoints, [join(agno, "app.py")]);

  // A pip-freeze OTel pin in a CrewAI app is CrewAI's own, not the customer's
  // exporter, so the framework recipe stays the verdict.
  const crewai = fixture(t, {
    "requirements.txt": [
      "crewai==1.15.17",
      "crewai-tools==1.15.17",
      "openai==2.30.0",
      "opentelemetry-sdk==1.42.0",
      "",
    ].join("\n"),
    "crew.py": "from crewai import Crew\n",
  });
  const crewaiReport = detect(["--dir", crewai, "--json"]).json();
  assert.equal(crewaiReport.route, 3);
  assert.equal(crewaiReport.framework, "CrewAI");
  const crewaiEvidence = crewaiReport.evidence.join(", ");
  assert.ok(crewaiReport.evidence.includes("CrewAI: crewai-tools"), crewaiEvidence);
  assert.ok(
    crewaiReport.evidence.includes("existing OpenTelemetry: opentelemetry-sdk"),
    crewaiEvidence,
  );

  const dspy = fixture(t, {
    "pyproject.toml": '[project]\nname = "app"\ndependencies = ["dspy>=3.3.0"]\n',
    "program.py": "import dspy\n",
  });
  assert.equal(detect(["--dir", dspy, "--json"]).json().framework, "DSPy");

  // dspy-ai is a compatibility alias for the same library.
  const alias = fixture(t, { "requirements.txt": "dspy-ai==3.3.0\n" });
  const aliasReport = detect(["--dir", alias, "--json"]).json();
  assert.equal(aliasReport.framework, "DSPy");
  assert.deepEqual(aliasReport.evidence, ["DSPy: dspy-ai"]);
});

test("CrewAI tools and companion packages are evidence but not a CrewAI verdict", (t) => {
  const toolsOnly = fixture(t, {
    "requirements.txt": "crewai-tools==1.15.17\ncrewai-cli==1.15.17\n",
  });
  const toolsReport = detect(["--dir", toolsOnly, "--json"]).json();
  assert.equal(toolsReport.route, 5);
  assert.equal(toolsReport.framework, "none recognized");
  assert.ok(
    toolsReport.evidence.includes("CrewAI: crewai-tools"),
    toolsReport.evidence.join(", "),
  );

  const mixed = fixture(t, {
    "requirements.txt": "crewai-tools==1.15.17\nopenai==2.30.0\n",
  });
  const mixedReport = detect(["--dir", mixed, "--json"]).json();
  assert.equal(mixedReport.route, 4);
  assert.equal(mixedReport.framework, "OpenAI SDK");
  assert.ok(
    mixedReport.evidence.includes("CrewAI: crewai-tools"),
    mixedReport.evidence.join(", "),
  );
  assert.ok(
    mixedReport.evidence.includes("OpenAI SDK: openai"),
    mixedReport.evidence.join(", "),
  );
});

test("the text output carries the framework's own next step, not the route's generic one", (t) => {
  const root = fixture(t, {
    "requirements.txt": "crewai==1.15.17\n",
  });
  const result = detect(["--dir", root]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^route 3: CrewAI$/m);
  assert.match(result.stdout, /CrewAIInstrumentor/);
  assert.doesNotMatch(result.stdout, /OpenInference or OpenLLMetry instrumentor at startup/);
});

test("a directory with no manifest is reported rather than answered", (t) => {
  const root = fixture(t, { "readme.md": "nothing here\n" });
  const result = detect(["--dir", root, "--json"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no package\.json, pyproject\.toml, requirements\.txt/);
  assert.equal(result.json().framework, "no manifests found");
});
