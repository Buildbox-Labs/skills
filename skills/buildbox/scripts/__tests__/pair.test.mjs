import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pair.mjs");

const KEY = "bbx_ingest_notarealkey000";
const ENV_LINES = [
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://api.example.com/v1/traces",
  `OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer%20${KEY}"`,
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf",
];
const DEDICATED_LINES = [
  "BUILDBOX_OTLP_TRACES_ENDPOINT=https://api.example.com/v1/traces",
  `BUILDBOX_OTLP_TRACES_AUTHORIZATION="Bearer ${KEY}"`,
];
const ANSWER = {
  endpoint: "https://api.example.com/v1/traces",
  key: KEY,
  env_lines: ENV_LINES,
  dedicated_env_lines: DEDICATED_LINES,
  status_url: "https://api.example.com/v1/traces/status",
};

/** A stand-in for the Buildbox collector, on a port the test owns. */
async function buildbox(t, reply) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url, body: Buffer.concat(chunks).toString("utf8") });
      reply(response, requests.length);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((closed) => server.close(closed)));
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/traces` };
}

const ok = (response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(ANSWER));
};

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "buildbox-pair-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Run the script without blocking this process: the stand-in server above
 *  answers on this event loop, so a synchronous child would deadlock. */
function pair(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PAIR, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("creates the env file with mode 600 and never prints the key", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), "apps", "agent", ".env.local");

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests[0].url, "/v1/traces/pair");
  assert.deepEqual(JSON.parse(server.requests[0].body), { code: "bbx_pair_notarealcode" });

  assert.match(result.stdout, /^wrote 3 variables to .*\.env\.local: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_TRACES_HEADERS, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL$/m);
  assert.match(result.stdout, /^status: https:\/\/api\.example\.com\/v1\/traces\/status$/m);
  assert.doesNotMatch(result.stdout, /bbx_ingest_/);
  assert.doesNotMatch(result.stderr, /bbx_ingest_/);

  assert.equal(readFileSync(envFile, "utf8"), `${ENV_LINES.join("\n")}\n`);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
});

test("replaces a variable in place, appends the rest, and keeps the other lines", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(
    envFile,
    [
      "# app",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://old.example.com/v1/traces",
      "OTHER=keep",
      "",
    ].join("\n"),
  );
  chmodSync(envFile, 0o644);

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(envFile, "utf8").split("\n"), [
    "# app",
    ENV_LINES[0],
    "OTHER=keep",
    ENV_LINES[1],
    ENV_LINES[2],
    "",
  ]);
  // S4: a file the customer already had keeps the permissions they gave it,
  // and the run says so once instead of tightening it behind their back.
  assert.equal(statSync(envFile).mode & 0o777, 0o644);
  assert.match(result.stderr, /can be read by other users/);
  assert.ok(result.stderr.includes(envFile), result.stderr);
});

test("--dedicated writes the Buildbox-only pair for an app that keeps its backend", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
    "--dedicated",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^wrote 2 variables to /m);
  assert.doesNotMatch(result.stdout, /bbx_ingest_/);
  assert.equal(readFileSync(envFile, "utf8"), `${DEDICATED_LINES.join("\n")}\n`);
});

test("a spent or expired code exits 3 and writes nothing", async (t) => {
  for (const status of [404, 410]) {
    const server = await buildbox(t, (response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "gone" }));
    });
    const envFile = join(workspace(t), ".env");

    const result = await pair([
      "--code",
      "bbx_pair_spent",
      "--endpoint",
      server.endpoint,
      "--env-path",
      envFile,
    ]);

    assert.equal(result.status, 3, `status ${status}`);
    assert.match(result.stderr, /^This pairing code is not valid any more\. Ask the customer to click New command on the Buildbox setup screen and give you the new code\.$/m);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(envFile), false);
  }
});

test("an unreachable endpoint exits 4 and writes nothing", async (t) => {
  const envFile = join(workspace(t), ".env");

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    "http://127.0.0.1:1/v1/traces",
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 4);
  assert.match(result.stderr, /could not reach Buildbox/);
  assert.equal(existsSync(envFile), false);
});

test("--env-file still works for a file that already exists", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(envFile, "OTHER=keep\n");

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-file",
    envFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(envFile, "utf8"), /^OTHER=keep$/m);
  assert.match(readFileSync(envFile, "utf8"), /^OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=/m);
});

test("missing arguments exit 2", async () => {
  const result = await pair(["--code", "bbx_pair_notarealcode"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node pair\.mjs/);
});

const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Put permissions back so the workspace can be removed, whichever order the
 *  cleanup hooks run in. */
function restore(t, path, mode) {
  t.after(() => {
    try {
      chmodSync(path, mode);
    } catch {
      // already gone
    }
  });
}

test("keeps the export prefix and the indentation of the line it replaces", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(
    envFile,
    [
      "export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://old.example.com/v1/traces",
      "  export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=grpc",
      "OTHER=keep",
      "",
    ].join("\n"),
  );

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(envFile, "utf8").split("\n"), [
    `export ${ENV_LINES[0]}`,
    `  export ${ENV_LINES[2]}`,
    "OTHER=keep",
    ENV_LINES[1],
    "",
  ]);
});

test("replaces the first copy of a variable and drops the later duplicates", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(
    envFile,
    [
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://old.example.com/v1/traces",
      "OTHER=keep",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://stale.example.com/v1/traces",
      "export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://staler.example.com/v1/traces",
      "",
    ].join("\n"),
  );

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  // dotenv and python-dotenv take the last line, so a stale copy below the one
  // we wrote would be the one the app actually used.
  assert.deepEqual(readFileSync(envFile, "utf8").split("\n"), [
    ENV_LINES[0],
    "OTHER=keep",
    ENV_LINES[1],
    ENV_LINES[2],
    "",
  ]);
  assert.match(result.stdout, /\(removed 2 duplicate lines\)$/m);
});

test("leaves the general endpoint variable alone while deduping the traces one", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(
    envFile,
    [
      "OTEL_EXPORTER_OTLP_ENDPOINT=https://other-vendor.example.com",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://old.example.com/v1/traces",
      "",
    ].join("\n"),
  );

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(envFile, "utf8"), /^OTEL_EXPORTER_OTLP_ENDPOINT=https:\/\/other-vendor\.example\.com$/m);
  assert.doesNotMatch(result.stdout, /duplicate/);
});

test("says nothing about duplicates or permissions on a clean 600 file", async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(envFile, "OTHER=keep\n", { mode: 0o600 });
  chmodSync(envFile, 0o600);

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /duplicate/);
  assert.doesNotMatch(result.stderr, /can be read by other users/);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
});

test("exits 2 before spending the code when the path cannot hold a file", async (t) => {
  const server = await buildbox(t, ok);
  const blocker = join(workspace(t), "notadir");
  writeFileSync(blocker, "");
  const envFile = join(blocker, "nested", ".env");

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not a directory/);
  // The point of the check: the code is still good.
  assert.equal(server.requests.length, 0);
});

test("exits 2 before spending the code when the env file is read-only", { skip: asRoot }, async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(envFile, "OTHER=keep\n");
  chmodSync(envFile, 0o400);

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot write /);
  assert.equal(server.requests.length, 0);
  assert.equal(readFileSync(envFile, "utf8"), "OTHER=keep\n");
});

test("exits 2 before spending the code when the directory is read-only", { skip: asRoot }, async (t) => {
  const server = await buildbox(t, ok);
  const locked = join(workspace(t), "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  restore(t, locked, 0o700);

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    join(locked, ".env"),
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /is not writable/);
  assert.equal(server.requests.length, 0);
});

test("an unreadable env file is not treated as absent", { skip: asRoot }, async (t) => {
  const server = await buildbox(t, ok);
  const envFile = join(workspace(t), ".env");
  writeFileSync(envFile, "OTHER=keep\n");
  chmodSync(envFile, 0o000);
  restore(t, envFile, 0o600);

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not read /);
  assert.equal(server.requests.length, 0);
  chmodSync(envFile, 0o600);
  assert.equal(readFileSync(envFile, "utf8"), "OTHER=keep\n");
});

test("exits 6 when the write fails after the code was redeemed", async (t) => {
  const envFile = join(workspace(t), ".env");
  // The path is writable when the script checks it and a directory by the time
  // it writes, which is the only way this failure happens after redemption.
  const server = await buildbox(t, (response) => {
    mkdirSync(envFile);
    ok(response);
  });

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    server.endpoint,
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 6);
  assert.equal(server.requests.length, 1);
  assert.match(
    result.stderr,
    /^The pairing code was redeemed but the env file could not be written; the key was not saved anywhere\. Fix the file permissions, then ask the customer for a new command\.$/m,
  );
  assert.doesNotMatch(result.stderr, /bbx_ingest_/);
  assert.equal(result.stdout, "");
});

test("refuses a plain http endpoint that is not localhost", async (t) => {
  const envFile = join(workspace(t), ".env");

  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    "http://api.example.com/v1/traces",
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /has to be https, or http on localhost/);
  assert.equal(existsSync(envFile), false);
});

test("allows plain http against the developer's own machine", async (t) => {
  for (const host of ["127.0.0.1", "localhost"]) {
    const server = await buildbox(t, ok);
    const port = new URL(server.endpoint).port;
    const envFile = join(workspace(t), ".env");

    const result = await pair([
      "--code",
      "bbx_pair_notarealcode",
      "--endpoint",
      `http://${host}:${port}/v1/traces`,
      "--env-path",
      envFile,
    ]);

    assert.equal(result.status, 0, `${host}: ${result.stderr}`);
    assert.equal(server.requests.length, 1);
  }
});

test("lets an IPv6 loopback endpoint through the scheme check", async (t) => {
  const envFile = join(workspace(t), ".env");

  // Nothing listens on port 1, so exit 4 (unreachable) is the proof the gate
  // let it through; exit 2 would mean the brackets around ::1 broke the check.
  const result = await pair([
    "--code",
    "bbx_pair_notarealcode",
    "--endpoint",
    "http://[::1]:1/v1/traces",
    "--env-path",
    envFile,
  ]);

  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /could not reach Buildbox/);
});
