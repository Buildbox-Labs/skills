---
name: buildbox
description: Connect a customer's AI agent to Buildbox agent analytics over OpenTelemetry. Use when someone asks to connect, set up, hook up, or send traces to Buildbox, or provides a Buildbox endpoint or gives a Buildbox pairing code. Detects the framework, writes standard OTel config, and loops until a real interaction shows up on the Buildbox setup screen.
---

# Connect an agent to Buildbox

Buildbox reads the conversations your agent already produces and reports where real
customer jobs fail. To do that it needs your traces. The door is plain OpenTelemetry
over HTTP, pointed at a Buildbox endpoint with an ingest key in the `Authorization`
header.

Your job in this skill: get the customer's app emitting OTel spans for its model and
tool calls, point the exporter at Buildbox, and keep going until a real interaction
through the running app shows up on the Buildbox setup screen.

## Hard rules

- **There is no Buildbox SDK.** Do not install, import, or invent one. Everything here
  is standard OpenTelemetry plus, where needed, a published instrumentation package.
- **Do not hand-build OTLP payloads, use a hand-rolled `fetch` to the endpoint, or write
  a custom exporter.** Use standard OpenTelemetry exporters.
- **Standard OpenTelemetry API spans are allowed only around real model and tool calls,
  as Route 5 prescribes. Never generate a synthetic proof span.** Setup is done when a
  real interaction arrives, and only then.
- **Never ask for Buildbox account credentials.** The only Buildbox secret in this flow
  is the ingest key, which is ingest-only and scoped to one workspace.
- **Never ask the customer to paste or reveal the ingest key or the full setup block.**
  Never print the key into source code, a commit, a log line, a terminal echo, or your
  reply. With a pairing code, `scripts/pair.mjs` writes the key into the app's
  environment file and you never see it. Without one, the customer puts it there
  themselves and confirms the key line is in place. It goes only into that file and, when
  needed, the deployment platform's secret environment store.
- **The pairing code is single-use and expires.** Use it only through
  `scripts/pair.mjs`, and never print it or the key.

## Step 1: detect, then ask only what detection could not settle

Run the detector that ships with this skill. Run it from the customer's repo root, and
spell out the script path from wherever the skill is installed, because the scripts scan
and resolve paths against the directory you run them from, not against their own:

```bash
node <skill dir>/scripts/detect.mjs --json
```

Add `--dir <app path>` when the customer already named the app, and give the same kind of
path to `--env-path` later: both are read relative to the directory you are in. The
report carries the route and its evidence, plus `apps`, `entrypoints`, `restart`,
`env_file`, and `env_file_safe`.

A field with one candidate is settled: take it and move on. Ask about the rest in one
message, not four:

1. **Which app**, when `apps` holds more than one candidate. In a monorepo this is the
   app that talks to the model, not the repo root. Re-run with `--dir <app path>`.

2. **The AI entrypoint**, when `entrypoints` is empty or lists several files. The file
   and function where the model call actually happens. Confirm it against the code rather
   than guessing from folder names.

3. **How the app restarts**, when `restart` is null. `pnpm dev`, `uvicorn --reload`, a
   Docker container, a deploy. You need this for the verification loop, and it tells you
   where environment variables actually come from.

4. **The environment file**, when `env_file` does not match how the app actually runs.

Then make that file safe, before any key exists. `env_file_safe` reports where it stands:

- `tracked: true` means the file is already committed. Stop and have the customer untrack
  it, then run the detector again. An ignore rule does nothing for a file that is already
  tracked, which is also why git reports such a file as not ignored.
- `ignored: false` with `tracked: false` means the ignore pattern is missing. Add it to
  `.gitignore`.
- `checked: false` means git could not answer, not that the file is safe. Run the two
  checks in "The env blocks" below by hand.

Verify that the file is ignored and untracked before continuing to step 2. Do not ask the
customer to open the Buildbox setup screen yet; with a pairing code they never have to.

## Step 2: pick the route

Step 1 reported the route. Read the code to confirm it before you change anything.

Take the **lightest route that applies**. A working exporter that is already there beats
anything you add.

### Route 1: the app already emits OpenTelemetry

Signals: `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-node`,
`@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-proto`,
`@opentelemetry/exporter-trace-otlp-http`, `@vercel/otel`, `opentelemetry-sdk`, an
`opentelemetry-exporter-otlp*` package, an existing tracer setup file, or an exporter
already pointed at another backend.

`@opentelemetry/api` alone is not route-1 evidence. It provides the API but no tracer
provider, so API calls are no-ops until an SDK/provider is registered. An API-only app
uses "A running provider, first" below, then follows the applicable instrumentation
route.

First inspect how the running exporter is constructed, including its concrete transport
and any `url`, `endpoint`, `headers`, or protocol options. For a single trace backend,
use the standard environment-only path only when the exporter reads its endpoint,
headers, and protocol from the standard OTel environment variables. If any of those
options are set in code, they take precedence over the environment. Edit the code to
use a concrete HTTP/protobuf exporter without code-set endpoint or header options for a
single backend, so it reads the standard endpoint and header variables below while its
class fixes the transport. Add the second Buildbox exporter described below when the
customer keeps the existing backend. A concrete gRPC exporter stays gRPC regardless of
`OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`. If the construction is indirect, turn on the
exporter's own logging and read the URL and transport it actually uses. You never
receive or inspect the header value.

Caveat: a dependency in the manifest is not proof that spans are emitted. Confirm there
is a tracer provider that actually starts, and that the model calls run inside it.

The common miss: a Next.js app has `@vercel/otel` registered and the `ai` package in the
same manifest, so the detector lands on route 1, and the tracer really is running. It is
emitting HTTP spans and no model-call spans, because nothing turned the AI SDK's
telemetry on. If the detector's evidence also lists the AI SDK, LangChain, or a bare
client SDK, do that route's instrumentation step **as well as** the applicable env
block. A running tracer provider is not the same thing as instrumented model calls, and
the difference looks like a connected setup with nothing in it.

The other route-1 trap: an app may already export through the standard
`OTEL_EXPORTER_OTLP_*` variables. The trace-scoped standard variables override the
generic standard variables for traces, so adding the three standard Buildbox lines can
silently redirect the existing exporter away from the customer's current backend.

If the customer wants to keep that backend, do not set any of the three standard
Buildbox lines. Leave every standard `OTEL_EXPORTER_OTLP_*` variable untouched. Use these
dedicated variables in the app's environment file instead. With a pairing code, run
`scripts/pair.mjs --dedicated` and it writes exactly these two. Without one, the customer
transposes the endpoint and authorization value from the private setup block themselves:

```bash
BUILDBOX_OTLP_TRACES_ENDPOINT=<endpoint URL from the setup screen>
BUILDBOX_OTLP_TRACES_AUTHORIZATION="Bearer <the bbx_ingest_ key>"
```

The authorization value uses a literal space after `Bearer`, not `%20`, because code
passes it as a runtime header value. In the existing tracer setup file, add a second span
processor with an HTTP/protobuf OTLP exporter. Configure its endpoint from
`BUILDBOX_OTLP_TRACES_ENDPOINT` and its exporter's `headers` option as
`{ Authorization: BUILDBOX_OTLP_TRACES_AUTHORIZATION }`, reading both values from the
environment. The agent references only those variable names and never reads either
value. The existing exporter continues to read its unchanged standard variables.

### Route 2: Vercel AI SDK

Signals: the `ai` package in `package.json`, calls to `generateText`, `streamText`, or
`generateObject`.

Work: first read the installed `ai` major from the app's `package.json`, then use the
matching recipe, then put the standard env block in place.

For `ai` major 6 or lower, turn on the SDK's built-in telemetry at every model call:

```ts
const result = await generateText({
  model,
  prompt,
  experimental_telemetry: {
    isEnabled: true,
    metadata: { userId: user.id, sessionId: chat.id },
  },
});
```

The `metadata` keys land on the span as `ai.telemetry.metadata.userId` and
`ai.telemetry.metadata.sessionId`, and Buildbox reads exactly those two for user
attribution and conversation grouping. For an AI SDK app this replaces the baggage
setup in "Always, on every route": pass the app's own user id and its existing chat or
thread id here on every call, and skip the baggage section. `userId` is replaced with a
keyed hash before analysis, like `user.id`.

The AI SDK emits into whatever OTel setup is registered in the process, so the app still
needs a tracer provider. On Next.js that is `instrumentation.ts` with
`@vercel/otel`; on plain Node it is `@opentelemetry/sdk-node` started before the app
code. If neither exists, add one, then come back to this step.

For `ai` major 7, install `@ai-sdk/otel`, register its integration once at application
startup alongside the tracer provider, and use the stable `telemetry` option for any
per-call metadata:

```ts
import { OpenTelemetry } from "@ai-sdk/otel";
import { generateText, registerTelemetry } from "ai";

registerTelemetry(new OpenTelemetry());

const result = await generateText({
  model,
  prompt,
  telemetry: {
    functionId: "agent",
    metadata: { userId: user.id, sessionId: chat.id },
  },
});
```

Registration enables telemetry for all AI SDK calls by default in major 7. The
`telemetry` option is only needed for metadata or to opt a call out. Set the same
`userId` and `sessionId` metadata keys as on the major-6 path, and for the same reason:
Buildbox reads them for user attribution and conversation grouping, so an AI SDK app
does not need the baggage setup.

### A running provider, first

Routes 3 through 5 instrument calls or create spans, but none can export without a
running tracer provider. Complete one setup below before applying those routes. The
exporters read the standard trace-scoped env block later in this skill.

Python: install `opentelemetry-sdk` and
`opentelemetry-exporter-otlp-proto-http`, then initialize once at process startup:

```python
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)
```

If the Python app is launched through a CLI, `opentelemetry-instrument` can auto-init
the provider and exporter instead of this code setup.

Node: install `@opentelemetry/sdk-node` and
`@opentelemetry/exporter-trace-otlp-proto`, then start the SDK before importing app
code:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
sdk.start();
await import("./app.js");
```

### Route 3: LangChain or LangGraph

Signals: `langchain`, `@langchain/core`, `@langchain/langgraph`, `langgraph`.

Work: complete "A running provider, first", register a published instrumentor, then put the
standard env block in place. Buildbox reads both the
OpenInference and the OpenLLMetry conventions, so either one is fine. Pick whichever the
customer already has; if neither, pick one and stay with it.

Python, OpenInference:

```python
from openinference.instrumentation.langchain import LangChainInstrumentor

LangChainInstrumentor().instrument()
```

Node, OpenInference: register the LangChain instrumentation with your
`NodeSDK` instrumentations list.

This goes in the process entrypoint, before the first chain or graph is built.

### Route 4: bare OpenAI, OpenAI Agents, Anthropic, or another client SDK

Signals: `openai`, `@openai/agents`, `openai-agents`, `@anthropic-ai/sdk`, `anthropic`,
and no framework above them.

Work: complete "A running provider, first", then add the matching instrumentor for that
client and put the standard env block in place. Same shape as
route 3, different package: the OpenInference or OpenLLMetry instrumentation for OpenAI
or Anthropic, registered once at startup. OpenAI Agents uses the matching instrumentor,
`openinference-instrumentation-openai-agents`.

If the app uses two clients, register both instrumentors.

### Route 5: nothing recognizable

Work: complete "A running provider, first", then add a minimal manual tracer around the
model call, written with the plain OpenTelemetry API. No Buildbox package, no custom
exporter, no invented attributes beyond the ones below.

```python
import json

from opentelemetry import trace

tracer = trace.get_tracer("app.agent")

with tracer.start_as_current_span("chat") as span:
    span.set_attribute("gen_ai.operation.name", "chat")
    span.set_attribute("gen_ai.provider.name", provider)
    span.set_attribute("gen_ai.request.model", model)
    span.set_attribute(
        "gen_ai.input.messages",
        json.dumps([{"role": "user", "content": user_message}]),
    )
    response = call_the_model(...)
    span.set_attribute("gen_ai.response.model", response.model)
    span.set_attribute(
        "gen_ai.output.messages",
        json.dumps([{"role": "assistant", "content": response.text}]),
    )
```

Wrap tool calls the same way with `gen_ai.operation.name` set to `execute_tool` and
`gen_ai.tool.name` set to the tool's name. The span name can also identify the call, but
Buildbox populates its tool name from the attribute. Keep it to the model call and the
tools around it; Buildbox assembles the rest.

Without message content, Buildbox can see that conversations happen but not what happens
in them. A `full` connection should capture messages, while `metadata_only` deliberately
does not.

## The env blocks

Once the environment file is verified safe and the route is selected, the variables can
go in. There are two ways to get them, and the pairing path is the one to try first.

### With a pairing code

If the customer's prompt carried a pairing code, redeem it. The script sends the code to
Buildbox, writes the lines it gets back into the environment file, and prints only the
variable names and the status URL. You never see the key.

```bash
node <skill dir>/scripts/pair.mjs --code <the pairing code> \
  --endpoint <the endpoint from the prompt> \
  --env-path <app environment file>
```

Add `--dedicated` on the route-1 path where the customer keeps an existing trace backend.
It writes the two `BUILDBOX_OTLP_TRACES_*` variables instead of the three standard ones,
and the second-exporter code in route 1 reads those.

The code works once and expires after fifteen minutes. Exit 3 means it is spent or
expired and nothing was written: ask the customer to click "New command" on the Buildbox
setup screen, then run the script again with the new code. Exit 2 and exit 4 also leave
the code unspent, so the same code still works once the cause is fixed: exit 2 is a bad
argument or an environment file the script cannot read or write, which it checks before
it posts the code, and exit 4 means Buildbox could not be reached. Exit 6 is the one that
costs a code: the code was redeemed and the write failed anyway, so the key is gone and
the customer needs a new command. Never print the code or the key.

Then read the four notes below. They are about what the lines mean and how each one fails
silently, and they hold however the lines got there.

### Without a pairing code

If no code was given, the quickest fix is to get one: ask the customer to open Buildbox,
then Setup, then Direct feed, click "Connect with my coding agent", and paste you the
command it shows (the pairing code is not the key; it works once and expires). Then use
the pairing path above. If they would rather paste the lines themselves, tell them to
click "Get my endpoint and key" on the same screen. The key is shown once,
so have them paste the applicable lines into that safe environment file as soon as they
appear and keep the setup screen open. Ask them to share only the endpoint URL and
variable names, which are non-secret, and to confirm that the applicable key line is in
place without sharing its value. Never ask for the full paste block, the key, or the
header value. If the key is lost or bad, stop and have the customer check the environment
file first, because a key that looks lost is usually a mis-pasted one. If it really is
gone, they can issue a new one themselves: Integrations, then "Rotate ingest key", or the
same action on the setup screen where the key is hidden. Rotating replaces the key at
once and the old one stops working, so they paste the new lines in and restart the app
before anything else.

### The lines themselves

For a single trace backend, these are the three standard lines, with exactly these names.
They apply on every route unless route 1 preserves an existing backend with the
code-configured second exporter described above. `pair.mjs` writes exactly these; a
customer pasting by hand pastes exactly these.

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<endpoint URL from the setup screen>
OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer%20<the bbx_ingest_ key>"
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
```

Four things about these lines, each of which fails silently when you get it wrong.

**The endpoint variable is the per-signal one.** `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
takes the full URL exactly as the setup screen gives it. The general
`OTEL_EXPORTER_OTLP_ENDPOINT` is defined as a base that an exporter appends `/v1/traces`
to, so the same value there makes a spec-compliant SDK post to `/v1/traces/v1/traces` and
get a 404. Use the per-signal name and paste the URL unchanged.

**The trace header scope and `%20` are deliberate.** The trace-scoped
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` prevents the Buildbox bearer key from being attached
to a customer's metrics or logs exporter for another vendor. Several OTel SDKs parse
the variable with baggage-style encoding, where a bare space in `Bearer <key>` is
mangled and the header arrives broken. In the environment variable, the space is `%20`.
If an existing exporter reads the header from the confirmed environment variable and
passes it through a `headers` option, its runtime header uses a literal space:
`Authorization: Bearer <the key>`. The two forms differ on purpose.

**The protocol line is not optional.** Buildbox accepts HTTP with protobuf or JSON
bodies. It does not speak gRPC. Several SDKs default to gRPC, and a gRPC exporter against
this endpoint fails quietly with nothing on the Buildbox side to show for it. This is the
single most common reason a setup looks finished and no traces arrive. Keep the
trace-scoped name: an existing `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=grpc` overrides a
generic protocol setting.

**Make the selected app's environment file safe before the key exists.** This is the file
step 1 settled: the one that will supply the variables to the running app. A Next.js run
may take them from `.env.local` or `.env.production`, dotenv defaults to `.env`, and a
container may declare an `env_file`. Use `<app environment file>` below for that exact
repo-relative path. From the repo root, run
`git check-ignore --quiet -- <app environment file>` to confirm that exact file is
ignored. If it is not, add the applicable pattern to `.gitignore`. Then run
`git ls-files --error-unmatch -- <app environment file>` from the repo root. Exit 0
means the app's environment file is already tracked, so stop and have the customer
untrack it. Re-run both checks and verify that the file is ignored and untracked before
any key exists. Only then redeem the pairing code, or, with no code, have the customer
put the applicable key lines in that file themselves. Either way you do not read the key
line back. For the code-configured multi-backend path, the applicable key lines are
`BUILDBOX_OTLP_TRACES_ENDPOINT` and `BUILDBOX_OTLP_TRACES_AUTHORIZATION`; the three
standard lines must remain unset for Buildbox. If the app deploys somewhere, set the
applicable variables in that environment too; a local environment file does not reach a
container or a serverless function.

## Always, on every route

**Multi-turn agents need a conversation id.** Buildbox groups spans into conversations
using `gen_ai.conversation.id` first, then `session.id`. Without one, every turn arrives
as its own one-shot conversation and the analysis loses the thing it exists to read: what
happened across the conversation.

Set it once per conversation and propagate it with OTel baggage, so it reaches every span
and not just the first one. This is the failure that catches people:

```python
from opentelemetry import baggage, context

ctx = baggage.set_baggage("gen_ai.conversation.id", conversation_id)
token = context.attach(ctx)
try:
    ...  # every span created in here carries the id
finally:
    context.detach(token)
```

Then copy the baggage value onto spans as an attribute, either with a span processor that
reads baggage on start, or by setting `gen_ai.conversation.id` explicitly on the spans you
create. Use the id your app already has for a thread or a chat, not a new one.

Single-shot agents with no follow-up turns can skip this. Vercel AI SDK apps can skip it
too: the `metadata: { userId, sessionId }` telemetry option in route 2 carries both ids
without any baggage code.

**Suggest a user id.** If the app knows who is talking, set `user.id` on the same spans.
Buildbox replaces it with a keyed hash before analysis. On a `full` connection, the raw
batch, like all trace content, first sits in a bounded, short-lived quarantine store for
no more than seven days; `metadata_only` hashes the id on arrival. The hashed id is what
later lets a finding say which customers hit a failure rather than only how often it
happened.

**Do not invent attribute names.** If a value does not fit one of the names above, leave
it off. A custom key nobody reads is noise in the customer's trace bill.

## Definition of done

Not when the code compiles. Not when a test span goes through. Done is:

1. **Restart the app yourself** when the restart command is a local one. Run it, then
   confirm the process really restarted; a hot reloader often does not re-read the app's
   environment file. When the app only runs somewhere you cannot reach, ask the customer
   to restart it.
2. **Perform one real interaction yourself**, through the app's real entrypoint: an HTTP
   call to the chat route, or a browser tool against the local UI. Against a local or
   staging instance only, never production. If you can reach neither, ask the customer to
   do it: an actual chat, an actual agent run, the thing the app is for. A request through
   the app's real code path is the interaction; a hand-made span is not.
3. **Wait for the span to land.**

   ```bash
   node <skill dir>/scripts/status.mjs --env-path <app environment file> --wait 90
   ```

   It reads the endpoint and the key out of the environment file, asks Buildbox, and
   prints the answer:
   `{"first_trace_at": "2026-08-17T14:02:11+00:00", "spans_accepted": 128}`, or
   `{"first_trace_at": null, "spans_accepted": 0}` when nothing has arrived yet. The
   answer carries no secret. Exit 0 means spans arrived. Exit 1 means still nothing after
   the wait, so go to troubleshooting. Exit 5 means the key in the file is not the live
   one, which is rung 3.
4. **The setup screen is the customer's signal.** Once the status read is green, point
   them at it: it flips from "Waiting for your first trace" to showing traces arriving.
5. For a `full` connection, both checks above only confirm trace arrival. After a few
   minutes, have the customer open Sessions from Home and check that the real interaction
   appears with turns before treating message capture as verified.

The deploy stays with the customer, and so does the decision to make it. Say which
variables go where: the ones now in the local environment file have to be set again in the
deployment platform's secret store before production traffic reaches Buildbox.

Do not declare success from your side of the connection, and do not send a synthetic
payload to make the screen move. A screen flipped by a fake span is a setup that will look
connected and report nothing.

### If this was a test, disconnect afterwards

For a real customer the connection stays. That is the product, and there is nothing to
clean up.

When this skill is run as a TEST, on staging, against an internal workspace, or as a
demo, the operator disconnects the connection when the test is over, from Settings in
the Buildbox app. A test connection that is left behind is a real connection that will
never receive another trace, and it goes on consuming worker scheduling until the
fairness backoff decays it. Disconnecting is the only thing that removes it.

## Troubleshooting, in this order

Work down the list. Each rung is more likely than the one after it, and the first two
cost nothing to check.

Run `scripts/status.mjs` first if you have not already. It separates two cases that look
alike: `spans_accepted` above zero means spans did reach Buildbox at some point and the
problem is with what arrived, while a flat zero means nothing ever landed and the rungs
below apply. It backs off on its own when Buildbox rate limits the read. Exit 5 is rung 3.

0. **`pair.mjs` exited 3.** The pairing code is spent or expired: codes work once and last
   fifteen minutes. Nothing was written and nothing is wrong with the app. Ask the
   customer to click "New command" on the Buildbox setup screen, then run `pair.mjs`
   again with the new code. Exit 6 reads the same way from the customer's side, but for a
   different reason: the code was redeemed and the environment file could not be written,
   so fix the file permissions the message names before asking for the new command.

1. **Exporter protocol.** On the standard path, is
   `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf` set and reaching an
   environment-configured exporter, or is the concrete exporter HTTP/protobuf? On the
   multi-backend path, is the code-configured Buildbox exporter HTTP/protobuf? Turn on
   the exporter's own logging and read the effective transport when it is unclear. A
   gRPC exporter against this endpoint produces no traces and no obvious error. This is
   the top cause.

2. **A leftover general endpoint variable on the standard path.** Our variable of record is
   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. If the environment also has
   `OTEL_EXPORTER_OTLP_ENDPOINT` set, from an earlier attempt or from another vendor's
   setup, the two can conflict, and a value there that already ends in `/v1/traces` makes
   an appending exporter post to `/v1/traces/v1/traces` and get a 404. Turn on the
   exporter's own logging, read the URL it posts to, and remove or repoint the general
   variable so only the per-signal one decides where traces go.

3. **401 from the endpoint.** The key is wrong, truncated, or has been rotated since it
   was pasted. On the standard path, have the customer check
   `OTEL_EXPORTER_OTLP_TRACES_HEADERS` themselves for `%20`. On the multi-backend path,
   have them check `BUILDBOX_OTLP_TRACES_AUTHORIZATION` themselves for a literal space
   and confirm that code passes it to the Buildbox exporter's `headers` option. Ask only
   for confirmation that the format is correct, never for the line or its value. If the
   line is wrong or the key is gone, the quickest fix on the pairing path is a new code:
   the customer clicks "New command", and `pair.mjs` overwrites the lines in place.
   Otherwise the customer issues a new key themselves: Integrations, then "Rotate ingest
   key", or the same action on the setup screen where the key is hidden. Either way the
   old key stops working at once, so the new lines go in and the app restarts before
   checking again. Stop here and do not print the key while checking.

4. **503 with a `Retry-After` header.** Buildbox has ingest paused for that workspace.
   Nothing is broken on the app side and OTel exporters queue and retry on their own.
   Wait it out rather than changing anything.

5. **The environment never reached the process.** Print the variable *names* that are set
   (never the values) from inside the running app. An environment file that the framework
   does not load, a container built before the variable existed, or a serverless function
   reading from a different env source are all common. Restart, and set the variables
   where that environment actually reads them from.

6. **Spans exist but no conversations.** Traces arrive and every conversation is one turn
   long: the conversation id is not propagating. Go back to the baggage section, or for
   an AI SDK app, the `metadata` option in route 2.

7. **Conversations arrive without message text on a `full` connection.** The instrumentor
   is not capturing content, which is a producer setting, not a Buildbox one. The official
   OTel GenAI instrumentations capture message content only when
   `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` is set in the app's
   environment. OpenInference and OpenLLMetry capture content by default, but both have
   env switches that hide it, so if text is missing there, print the variable *names* in
   the environment and look for their hide/trace-content settings. On the AI SDK path,
   per-call `recordInputs`/`recordOutputs: false` disables capture for that call.

## Instrumentation packages

All published, none from Buildbox. Install the current version and let the lockfile pin
it. These APIs move between majors, so when an init snippet stops matching, check the
instrumentor's own README before rewriting it.

- OpenInference: `openinference-instrumentation-langchain`,
  `openinference-instrumentation-openai`,
  `openinference-instrumentation-openai-agents`,
  `openinference-instrumentation-anthropic` (Python),
  `@arizeai/openinference-instrumentation-*` (Node).
- OpenLLMetry: `opentelemetry-instrumentation-langchain`,
  `opentelemetry-instrumentation-openai`, `opentelemetry-instrumentation-anthropic`
  (Python), `@traceloop/*` (Node).
- Core OTel: `opentelemetry-sdk` and `opentelemetry-exporter-otlp-proto-http` (Python),
  `@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-proto` (Node),
  `@vercel/otel` on Next.js.

## Script helpers

Three scripts ship in this skill's `scripts/` directory. All three are plain Node with no
dependencies, and none of them prints the ingest key or the pairing code.

**`detect.mjs`** reads the app's `package.json`, `pyproject.toml`, and `requirements.txt`
and reports which route applies, plus the facts step 1 would otherwise have to ask for.

```bash
node <skill dir>/scripts/detect.mjs --json
node <skill dir>/scripts/detect.mjs --dir ./apps/agent --json
```

`--json` prints `{route, framework, evidence, app, apps, entrypoints, restart, env_file,
env_file_safe}`. It reads files only: no network, no writes. It is a starting point, not
a verdict. Confirm the route against the entrypoint before you edit anything.

**`pair.mjs`** redeems a pairing code and writes the environment lines it gets back.

```bash
node <skill dir>/scripts/pair.mjs --code <code> --endpoint <endpoint> \
  --env-path <file> [--dedicated]
```

It creates the file with owner-only permissions when it is missing, and leaves the
permissions alone on a file that is already there, warning once if other users can read
it. It replaces a variable already in the file where it stands, keeping any `export`
prefix, drops later duplicate lines for the same variable, and appends the rest. It prints
the variable names it wrote and the status URL, nothing else. Exit 3 means the code is
spent or expired, exit 4 means Buildbox could not be reached, exit 2 means the arguments
were wrong or the environment file cannot be read or written. On all three nothing was
written and the code is still good. Exit 6 is the exception: the code was redeemed and the
write failed, so the key is gone and the customer needs a new command. The endpoint has to
be https, or http on localhost for a developer's own machine.

**`status.mjs`** asks Buildbox whether the spans arrived, using the key already in the
environment file.

```bash
node <skill dir>/scripts/status.mjs --env-path <file> --wait 90
```

It reads either variable form, the three standard `OTEL_` lines or the two dedicated
`BUILDBOX_` ones, and it holds the endpoint to the same https rule. Exit 0 means spans
have arrived, 1 means none yet, 5 means the key was rejected, 4 means Buildbox could not
be reached or would not answer within the wait (a rate limit longer than `--wait` is
reported this way, with the seconds to hold off; it says nothing about whether spans
arrived), 2 means the file had no Buildbox variables or an endpoint the script will not
call. Add `--wait 0` for a single read, `--interval <seconds>` to poll at a different
pace.

The path flag is `--env-path`, not `--env-file`, in both scripts: node reads an
`--env-file` argument itself wherever it appears on the command line, and quits before the
script runs when that file does not exist yet.
