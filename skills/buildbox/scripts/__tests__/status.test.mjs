import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = join(SCRIPTS, "status.mjs");
const PAIR = join(SCRIPTS, "pair.mjs");

const KEY = "bbx_ingest_notarealkey000";

/** A stand-in for the Buildbox status read, on a port the test owns. */
async function buildbox(t, reply) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    reply(response, requests.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((closed) => server.close(closed)));
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/traces` };
}

const answer = (response, body) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** Run a script without blocking this process: the stand-in server above
 *  answers on this event loop, so a synchronous child would deadlock. */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

const status = (args) => run(STATUS, args);

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "buildbox-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function envFileWith(t, lines) {
  const path = join(workspace(t), ".env");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const standard = (endpoint) => [
  "# app",
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${endpoint}`,
  `OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer%20${KEY},x-source=app"`,
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf",
];

const dedicated = (endpoint) => [
  `BUILDBOX_OTLP_TRACES_ENDPOINT=${endpoint}`,
  `BUILDBOX_OTLP_TRACES_AUTHORIZATION="Bearer ${KEY}"`,
];

test("reads the standard variables, exits 0 once spans have arrived", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, { first_trace_at: "2026-08-17T14:02:11+00:00", spans_accepted: 128 }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "10", "--interval", "1"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/v1/traces/status");
  assert.equal(server.requests[0].authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    first_trace_at: "2026-08-17T14:02:11+00:00",
    spans_accepted: 128,
  });
  assert.match(result.stderr, /arrived/);
  assert.doesNotMatch(result.stdout, /bbx_ingest_/);
  assert.doesNotMatch(result.stderr, /bbx_ingest_/);
});

test("reads the dedicated variables of the keep-your-backend path", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, { first_trace_at: "2026-08-17T14:02:11+00:00", spans_accepted: 4 }),
  );
  const path = envFileWith(t, dedicated(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "0"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests[0].authorization, `Bearer ${KEY}`);
  assert.equal(JSON.parse(result.stdout).spans_accepted, 4);
});

test("backs off on 429 and keeps polling until spans arrive", async (t) => {
  const server = await buildbox(t, (response, count) => {
    if (count === 1) {
      response.writeHead(429, { "retry-after": "1", "content-type": "application/json" });
      response.end("{}");
      return;
    }
    answer(response, { first_trace_at: "2026-08-17T14:02:11+00:00", spans_accepted: 2 });
  });
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "20", "--interval", "1"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.length, 2);
  assert.match(result.stderr, /waiting/);
  assert.equal(JSON.parse(result.stdout).spans_accepted, 2);
});

test("a rate limit longer than the wait exits 4 and does not claim nothing arrived", async (t) => {
  const server = await buildbox(t, (response) => {
    response.writeHead(429, { "retry-after": "60", "content-type": "application/json" });
    response.end("{}");
  });
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "1", "--interval", "1"]);

  assert.equal(result.status, 4, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.match(result.stderr, /rate-limited the status read/);
  assert.match(result.stderr, /60 seconds/);
  assert.equal(result.stdout, "");
});

test("exits 1 when nothing has arrived, and --wait 0 reads once", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, { first_trace_at: null, spans_accepted: 0 }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "0"]);

  assert.equal(result.status, 1);
  assert.equal(server.requests.length, 1);
  assert.deepEqual(JSON.parse(result.stdout), { first_trace_at: null, spans_accepted: 0 });
  assert.match(result.stderr, /waiting/);
});

test("polls more than once while it waits", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, { first_trace_at: null, spans_accepted: 0 }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "2", "--interval", "1"]);

  assert.equal(result.status, 1);
  assert.ok(server.requests.length >= 2, `polled ${server.requests.length} times`);
});

test("a rejected key exits 5 without printing the key", async (t) => {
  const server = await buildbox(t, (response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "unauthorized" }));
  });
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "10", "--interval", "1"]);

  assert.equal(result.status, 5);
  assert.equal(server.requests.length, 1);
  assert.match(result.stderr, /not the live one/);
  assert.doesNotMatch(result.stdout, /bbx_ingest_/);
  assert.doesNotMatch(result.stderr, /bbx_ingest_/);
});

test("an unreachable endpoint exits 4", async (t) => {
  const path = envFileWith(t, standard("http://127.0.0.1:1/v1/traces"));

  const result = await status(["--env-path", path, "--wait", "0"]);

  assert.equal(result.status, 4);
  assert.match(result.stderr, /could not reach Buildbox/);
});

// The two scripts have to agree on the bytes in the env file, on both forms of
// the block. These run pair.mjs first, then read back what it actually wrote.
for (const dedicated of [false, true]) {
  const label = dedicated ? "the dedicated pair" : "the standard three lines";
  test(`reads ${label} exactly as pair.mjs writes them`, async (t) => {
    let endpoint = "";
    const server = await buildbox(t, (response, count) => {
      if (count === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            endpoint,
            key: KEY,
            env_lines: [
              `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${endpoint}`,
              `OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer%20${KEY}"`,
              "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf",
            ],
            dedicated_env_lines: [
              `BUILDBOX_OTLP_TRACES_ENDPOINT=${endpoint}`,
              `BUILDBOX_OTLP_TRACES_AUTHORIZATION="Bearer ${KEY}"`,
            ],
            status_url: `${endpoint}/status`,
          }),
        );
        return;
      }
      answer(response, { first_trace_at: "2026-08-17T14:02:11+00:00", spans_accepted: 1 });
    });
    endpoint = server.endpoint;
    const path = join(workspace(t), ".env.paired");

    const written = await run(PAIR, [
      "--code",
      "bbx_pair_notarealcode",
      "--endpoint",
      endpoint,
      "--env-path",
      path,
      ...(dedicated ? ["--dedicated"] : []),
    ]);
    assert.equal(written.status, 0, written.stderr);
    assert.doesNotMatch(written.stdout, /bbx_ingest_/);

    const result = await status(["--env-path", path, "--wait", "0"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(server.requests[1].url, "/v1/traces/status");
    assert.equal(server.requests[1].authorization, `Bearer ${KEY}`);
  });
}

test("--baseline exits 0 once the delta is reached and holds through the settle window", async (t) => {
  const server = await buildbox(t, (response, count) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 6,
      // Spans are already there on the first read; the grouping catches up, and
      // then the count stays where it landed.
      conversations_seen: count === 1 ? 3 : 4,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "20",
    "--interval",
    "1",
    "--baseline",
    "3",
    "--settle",
    "2",
  ]);

  assert.equal(result.status, 0, result.stderr);
  // The reaching read, then at least one more inside the settle window.
  assert.ok(server.requests.length >= 3, `requests: ${server.requests.length}`);
  assert.match(result.stderr, /waiting, conversations_seen: 3/);
  assert.match(result.stderr, /settling, conversations_seen: 4/);
  assert.match(result.stderr, /arrived, conversations_seen: 4/);
  assert.equal(JSON.parse(result.stdout).conversations_seen, 4);
});

test("--wait 0 with a baseline judges the single read and never opens a settle window", async (t) => {
  const onTarget = await buildbox(t, (response) =>
    answer(response, { first_trace_at: "2026-08-17T14:02:11+00:00", spans_accepted: 6, conversations_seen: 4 }),
  );
  const path = envFileWith(t, standard(onTarget.endpoint));

  const reached = await status(["--env-path", path, "--wait", "0", "--baseline", "3"]);

  assert.equal(reached.status, 0, reached.stderr);
  assert.equal(onTarget.requests.length, 1);
  assert.match(reached.stderr, /arrived, conversations_seen: 4/);

  const above = await buildbox(t, (response) =>
    answer(response, { first_trace_at: "2026-08-17T14:02:11+00:00", spans_accepted: 6, conversations_seen: 5 }),
  );
  const path2 = envFileWith(t, standard(above.endpoint));

  const overshot = await status(["--env-path", path2, "--wait", "0", "--baseline", "3"]);

  assert.equal(overshot.status, 1);
  assert.equal(above.requests.length, 1);
  assert.match(overshot.stderr, /conversations_seen settled at 5, past the 4/);
});

test("an overshoot that lasts the whole settle window exits 1 and names broken grouping", async (t) => {
  const server = await buildbox(t, (response, count) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 9,
      // The delta is met, and then a second conversation shows up and stays:
      // the two turns were split rather than grouped under one id.
      conversations_seen: count === 1 ? 4 : 5,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "10",
    "--interval",
    "1",
    "--baseline",
    "3",
    "--new-conversations",
    "1",
    "--settle",
    "2",
  ]);

  assert.equal(result.status, 1);
  // The high read no longer ends the run on its own: the window has to close on
  // it first, which takes a read to open the window and a read to close it.
  assert.ok(server.requests.length >= 3, `requests: ${server.requests.length}`);
  assert.match(result.stderr, /conversations_seen settled at 5/);
  assert.match(result.stderr, /more conversations than turns you sent under one conversation id/);
  assert.match(result.stderr, /rung 6/);
  assert.equal(JSON.parse(result.stdout).conversations_seen, 5);
});

test("an overshoot on the first read that settles back to the target exits 0", async (t) => {
  const server = await buildbox(t, (response, count) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 9,
      // The transient split Buildbox shows while it is still merging batches:
      // one high read, then the real number.
      conversations_seen: count === 1 ? 5 : 4,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "20",
    "--interval",
    "1",
    "--baseline",
    "3",
    "--new-conversations",
    "1",
    "--settle",
    "2",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(server.requests.length >= 2, `requests: ${server.requests.length}`);
  assert.match(result.stderr, /settling, conversations_seen: 5/);
  assert.match(result.stderr, /arrived, conversations_seen: 4/);
  assert.doesNotMatch(result.stderr, /grouping is broken/);
  assert.equal(JSON.parse(result.stdout).conversations_seen, 4);
});

test("a count still climbing when the window closes gets one more window", async (t) => {
  // --settle below --interval means the read after the window opens is the one
  // that closes it, so the sequence below is exact: 4 opens, 5 closes it while
  // still climbing, and the extra window closes on 4.
  const server = await buildbox(t, (response, count) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 9,
      conversations_seen: count === 2 ? 5 : 4,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "20",
    "--interval",
    "5",
    "--baseline",
    "3",
    "--settle",
    "1",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.length, 3);
  assert.match(result.stderr, /settling, conversations_seen: 5/);
  assert.match(result.stderr, /arrived, conversations_seen: 4/);
});

test("the window is extended once, not for as long as the count keeps rising", async (t) => {
  const server = await buildbox(t, (response, count) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 9,
      // Never stops climbing: 4, 5, 6, 7 ...
      conversations_seen: 3 + count,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "20",
    "--interval",
    "5",
    "--baseline",
    "3",
    "--settle",
    "1",
  ]);

  assert.equal(result.status, 1);
  assert.ok(server.requests.length <= 6, `requests: ${server.requests.length}`);
  assert.match(result.stderr, /conversations_seen settled at 6/);
  assert.match(result.stderr, /rung 6/);
});

test("an overshoot that came down but stayed high reports the peak beside the settled value", async (t) => {
  const server = await buildbox(t, (response, count) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 9,
      // One merge lands during the window and then the count holds at 5, which
      // is still above the target of 4. The window has to see 5 more than once,
      // or this would be a count caught mid-fall rather than a settled one.
      conversations_seen: count === 1 ? 6 : 5,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "20",
    "--interval",
    "1",
    "--baseline",
    "3",
    "--settle",
    "3",
  ]);

  assert.equal(result.status, 1);
  assert.ok(server.requests.length >= 4, `requests: ${server.requests.length}`);
  assert.match(result.stderr, /conversations_seen settled at 5, after a peak of 6/);
  assert.match(result.stderr, /rung 6/);
});

test("a count that merges back below the target goes on waiting inside the wait", async (t) => {
  const server = await buildbox(t, (response, count) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 9,
      // Reaches the target, drops under it while assembly re-keys a row, and
      // comes back. The run has to wait that out rather than call it a miss.
      conversations_seen: count === 2 ? 3 : 4,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "20",
    "--interval",
    "2",
    "--baseline",
    "3",
    "--settle",
    "1",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(server.requests.length >= 4, `requests: ${server.requests.length}`);
  assert.match(result.stderr, /waiting, conversations_seen: 3/);
  assert.match(result.stderr, /arrived, conversations_seen: 4/);
});

test("a delta that never arrives exits 1 and names the grouping rung", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 12,
      conversations_seen: 3,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "0", "--baseline", "3"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /spans arrived but the conversations have not/);
  assert.match(result.stderr, /waiting for 4/);
  assert.match(result.stderr, /rung 6/);
  assert.doesNotMatch(result.stderr, /more conversations than turns/);
  assert.equal(JSON.parse(result.stdout).conversations_seen, 3);
});

test("a baseline at the conversation cap exits 2 without reading anything", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, { first_trace_at: null, spans_accepted: 0, conversations_seen: 1000 }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const capped = await status(["--env-path", path, "--wait", "0", "--baseline", "1000"]);

  assert.equal(capped.status, 2);
  assert.match(capped.stderr, /counted up to 1000/);
  assert.match(capped.stderr, /Sessions screen/);
  assert.equal(server.requests.length, 0);

  // A baseline of 999 expecting one more lands on the cap, where an overshoot is
  // invisible, so that is refused too.
  const onCap = await status(["--env-path", path, "--wait", "0", "--baseline", "999"]);

  assert.equal(onCap.status, 2);
  assert.match(onCap.stderr, /baseline of 999 expecting 1 more/);
  assert.equal(server.requests.length, 0);

  // Below the cap the target is exact, so the delta check still runs.
  const below = await status(["--env-path", path, "--wait", "0", "--baseline", "998"]);

  assert.equal(below.status, 1);
  assert.equal(server.requests.length, 1);
});

test("a Buildbox that does not report conversations_seen says so instead of reading it as zero", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, { first_trace_at: "2026-08-17T14:02:11+00:00", spans_accepted: 3 }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status([
    "--env-path",
    path,
    "--wait",
    "20",
    "--interval",
    "1",
    "--baseline",
    "0",
  ]);

  assert.equal(result.status, 1);
  // Waiting cannot make an absent field appear, so it does not poll for it.
  assert.equal(server.requests.length, 1);
  assert.match(result.stderr, /did not report conversations_seen/);
  assert.doesNotMatch(result.stderr, /rung 6/);
  assert.equal(JSON.parse(result.stdout).spans_accepted, 3);
});

test("without --baseline, a conversations_seen of zero still exits 0 on spans", async (t) => {
  const server = await buildbox(t, (response) =>
    answer(response, {
      first_trace_at: "2026-08-17T14:02:11+00:00",
      spans_accepted: 8,
      conversations_seen: 0,
    }),
  );
  const path = envFileWith(t, standard(server.endpoint));

  const result = await status(["--env-path", path, "--wait", "0"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    first_trace_at: "2026-08-17T14:02:11+00:00",
    spans_accepted: 8,
    conversations_seen: 0,
  });
});

test("a delta argument that cannot be a count exits 2", async (t) => {
  const path = envFileWith(t, standard("https://api.example.com/v1/traces"));

  for (const value of ["two", "-1", "1.5"]) {
    const result = await status(["--env-path", path, "--baseline", value]);
    assert.equal(result.status, 2, `--baseline ${value}`);
    assert.match(result.stderr, /--baseline <n>/);
  }

  // Zero new conversations would pass on the baseline alone.
  const zero = await status(["--env-path", path, "--baseline", "3", "--new-conversations", "0"]);
  assert.equal(zero.status, 2);
  assert.match(zero.stderr, /--new-conversations <k>/);
});

test("--new-conversations without a baseline exits 2", async (t) => {
  const path = envFileWith(t, standard("https://api.example.com/v1/traces"));

  const result = await status(["--env-path", path, "--wait", "0", "--new-conversations", "1"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs --baseline/);
});

test("an env file with no Buildbox variables exits 2", async (t) => {
  const path = envFileWith(t, ["OTHER=keep"]);

  const result = await status(["--env-path", path]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /no Buildbox endpoint and key/);
});

test("refuses an endpoint in the env file that is plain http and not localhost", async (t) => {
  const path = envFileWith(t, standard("http://api.example.com/v1/traces"));

  const result = await status(["--env-path", path, "--wait", "0"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /has to be https, or http on localhost/);
  assert.doesNotMatch(result.stderr, /bbx_ingest_/);
});

test("refuses a plain http endpoint on the dedicated variables too", async (t) => {
  const path = envFileWith(t, dedicated("http://api.example.com/v1/traces"));

  const result = await status(["--env-path", path, "--wait", "0"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /has to be https, or http on localhost/);
});
