---
name: buildbox
description: Connect a customer's AI agent to Buildbox agent analytics over OpenTelemetry. Use when someone asks to connect, set up, hook up, or send traces to Buildbox, or provides a Buildbox endpoint. Detects the framework, writes standard OTel config, and loops until a real interaction shows up on the Buildbox setup screen.
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
  reply. The customer puts it into the app's environment file themselves and confirms
  the key line is in place. It goes only into that file and, when needed, the deployment
  platform's secret environment store.

## Step 1: collect the inputs

Collect the first three non-secret app details up front, in one message. Use them to
identify and secure the environment file before selecting the route. Do not ask the
customer to open the Buildbox setup screen yet.

1. **Which app.** In a monorepo, the path to the app that talks to the model, not the
   repo root.

2. **The AI entrypoint.** The file and function where the model call actually happens.
   Ask, then confirm it against the code rather than guessing from folder names.

3. **How the app restarts.** `pnpm dev`, `uvicorn --reload`, a Docker container, a
   deploy. You need this for the verification loop, and it tells you where environment
   variables actually come from.

4. **The safe environment file.** Identify the exact app environment file from the
   framework convention and restart method. Complete the ignore, tracked-file, and any
   needed untracking checks in "The env blocks" below now. Verify that the file is
   ignored and untracked before continuing to step 2. The customer must not open the
   setup screen or mint the key yet.

## Step 2: pick the route

Run the detector that ships beside this file, then read the code to confirm it. Paths are
relative to this skill's own directory:

```bash
node scripts/detect.mjs --dir <app path>
```

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
Buildbox lines. Leave every standard `OTEL_EXPORTER_OTLP_*` variable untouched. Have the
customer transpose the endpoint and authorization value from the private setup block
into these dedicated variables in the app's environment file themselves:

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
matching recipe and have the customer confirm the standard env block is in place.

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

Work: complete "A running provider, first", register a published instrumentor, then have
the customer confirm the standard env block is in place. Buildbox reads both the
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
client and have the customer confirm the standard env block is in place. Same shape as
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

After the environment file is verified safe and the route is selected, tell the
customer to open Buildbox: Setup, then Direct feed, then "Get my endpoint and key". The
key is shown once, so have them paste the applicable lines into that safe environment
file as soon as they appear and keep the setup screen open. Ask them to share only the
endpoint URL and variable names, which are non-secret, and to confirm that the
applicable key line is in place without sharing its value. Never ask for the full paste
block, the key, or the header value. If the key is lost or bad, stop and have the
customer check the environment file first, because a key that looks lost is usually a
mis-pasted one. If it really is gone, they can issue a new one themselves: Integrations,
then "Rotate ingest key", or the same action on the setup screen where the key is
hidden. Rotating replaces the key at once and the old one stops working, so they paste
the new lines in and restart the app before anything else.

For a single trace backend, use these three standard lines with exactly these names.
They apply on every route unless route 1 preserves an existing backend with the
code-configured second exporter described above.

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

**Make the selected app's environment file safe before the key exists.** Identify the
exact file that will supply the variables to the running app, using the framework's
convention and the restart method collected in step 1. A Next.js run may take them from
`.env.local` or `.env.production`, dotenv defaults to `.env`, and a container may
declare an `env_file`. Use `<app environment file>` below for that exact repo-relative
path. From the repo root, run
`git check-ignore --quiet -- <app environment file>` to confirm that exact file is
ignored. If it is not, add the applicable pattern to `.gitignore`. Then run
`git ls-files --error-unmatch -- <app environment file>` from the repo root. Exit 0
means the app's environment file is already tracked, so stop and have the customer
untrack it. Re-run both checks and verify that the file is ignored and untracked before
the customer opens the setup screen or mints the key. Only then have the customer put
the applicable key lines in that file themselves. Do not write or inspect the key line
yourself. For the code-configured multi-backend path, the applicable key lines are
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

1. Restart the app so it picks up the new environment and code. Confirm the process
   really restarted; a hot reloader often does not re-read the app's environment file.
2. Have the customer perform **one real interaction** through the app: an actual chat, an
   actual agent run, the thing the app is for.
3. Ask them to look at the Buildbox setup screen. It flips from "Waiting for your first
   trace" to showing traces arriving. This is the primary signal.
4. Optionally, confirm the same thing from the machine you just instrumented. Buildbox
   answers a read at the same endpoint with `/status` on the end, using the key already
   in the environment. Give the customer the command for their route and have them run
   it in the shell where the app's variables are loaded. Never type the key into it and
   never ask them to read it back.

   Standard path:

   ```bash
   key="${OTEL_EXPORTER_OTLP_TRACES_HEADERS##*Bearer%20}"
   curl -sS -H "Authorization: Bearer ${key%%,*}" \
     "$OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/status"
   ```

   Code-configured multi-backend path:

   ```bash
   curl -sS -H "Authorization: $BUILDBOX_OTLP_TRACES_AUTHORIZATION" \
     "$BUILDBOX_OTLP_TRACES_ENDPOINT/status"
   ```

   The two commands differ because the two variables do: the standard one holds
   `Authorization=Bearer%20<key>` for an SDK that baggage-parses it, and a curl header
   needs the bare key after a literal space, so the substitution strips the prefix and
   the encoding. The answer is
   `{"first_trace_at": "2026-08-12T14:02:11+00:00", "spans_accepted": 128}`, or
   `{"first_trace_at": null, "spans_accepted": 0}` when nothing has arrived yet. It
   carries no secret, so the customer can paste the output straight back to you. A 401
   means the key in that environment is not the live one; go to troubleshooting.
5. For a `full` connection, both checks above only confirm trace arrival. After a few
   minutes, have the customer open Sessions from Home and check that the real interaction
   appears with turns before treating message capture as verified.

If the screen still says waiting after a minute, go to troubleshooting. Do not declare
success from your side of the connection, and do not send a synthetic payload to make the
screen move. A screen flipped by a fake span is a setup that will look connected and
report nothing.

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

Run the status command from step 4 of the definition of done first if you have not
already. It separates two cases that look alike: `spans_accepted` above zero means spans
did reach Buildbox at some point and the problem is with what arrived, while a flat zero
means nothing ever landed and the rungs below apply. A 429 means the status poller is
running too fast; back off before retrying. A 401 from it is rung 3.

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
   line is wrong or the key is gone, the customer issues a new one themselves:
   Integrations, then "Rotate ingest key", or the same action on the setup screen where
   the key is hidden. Rotating replaces the key at once and the old one stops working,
   so they paste the new lines in and restart the app before checking again. Stop here
   and do not print the key while checking.

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

## Script helper

`scripts/detect.mjs`, in this skill's directory, reads the target directory's
`package.json`, `pyproject.toml`, and `requirements.txt` and reports which route applies.

```bash
node scripts/detect.mjs --dir ./apps/agent
node scripts/detect.mjs --dir ./apps/agent --json
```

`--json` prints `{route, framework, evidence}`. It reads files only: no network, no
writes. It is a starting point, not a verdict. Confirm the route against the entrypoint
before you edit anything.
