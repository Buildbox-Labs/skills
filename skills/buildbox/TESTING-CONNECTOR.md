# Connect an agent to Buildbox Testing with the connector

Buildbox Testing runs test conversations against the customer's agent and
reports observed goal results and recurring behaviors, with transcripts as
evidence. It needs a way to reach the agent. The usual way is an HTTP endpoint.
This recipe is the other way: a small bridge process that runs next to their
agent and connects out to Buildbox, so nothing has to be exposed.

Use this recipe when the customer says any of: their agent has no public
endpoint, it runs on a laptop or inside a private network, it is reached only
through a chat channel, or the Testing page's connect screen sent them here with
a connector key.

This is not the trace-sending setup. If the customer is trying to send their
production traffic to Buildbox, use the main `SKILL.md` instead. This recipe
only makes their agent reachable for test conversations.

## What you are about to do

1. Find the function in their code that produces the agent's reply to a
   conversation.
2. Install the Buildbox bridge (Python or Node).
3. Write a small wrapper file that maps their function to
   `reply(messages, channel, sender=None)` in Python or
   `reply(messages, channel, sender)` in JavaScript.
4. Run the bridge's self-test, which never touches the network.
5. Start the bridge with the connector key from the Testing page.
6. Confirm the Testing page shows the connector as connected.

## Three things the customer has to approve, before you start

Say all three in one message and wait for a yes. Do not start until you have it.

1. **A code change in their repo.** Add a wrapper around the existing reply
   path; a small refactor may be needed to expose that path as a function.
2. **The connector key.** It is minted on the Buildbox Testing page and shown
   once. It can receive and answer test conversations for this workspace, but
   it is not a Buildbox login and cannot access other workspace data.
3. **One outbound connection.** The bridge connects out to Buildbox from
   wherever they run it. It never opens a port and nothing connects in.

## Hard rules

- **Never ask for the key in chat, and never write it into a file, a commit, a
  log line, or your reply.** The bridge reads it from the environment variable
  `BUILDBOX_CONNECTOR_KEY`. Tell the customer to export it in the shell they
  will run the bridge in, or to put it in their secret store for a deployed
  bridge. If they paste it to you anyway, use it for the one command and never
  repeat it back.
- **Do not build your own client.** The bridge package speaks the wire contract,
  handles reconnects, and falls back to polling. Do not write a websocket
  client, do not hand-roll HTTP calls to Buildbox, and do not invent an SDK.
- **The wrapper calls their real agent.** Do not stub it, do not add canned
  answers, and do not write a wrapper that ignores the conversation history.
  A test run against a stub proves nothing.
- **Never ask for Buildbox account credentials.**
- **Leave their agent's behaviour alone.** The wrapper adapts the shape of a
  call. It does not change prompts, models, tools, or routing.

## Step 1: find the reply function

You are looking for one function that takes the conversation so far and returns
what the agent says. It usually already exists, one layer under whatever handles
their transport (an HTTP route, a Slack handler, a CLI loop).

Search their repo for the layer that owns a conversation, then read the layer
under it:

```bash
rg -n "messages|conversation|history" --type py --type ts -l | head -30
rg -n "def (chat|respond|reply|handle_message|run_agent)" --type py | head -20
rg -n "(export (async )?function|const) (chat|respond|reply|handleMessage|runAgent)" --type ts | head -20
```

Framework hints, in the order they usually appear:

- **LangGraph (Python or JS).** The seam is the compiled graph:
  `graph.invoke({"messages": [...]})` or `await graph.invoke({ messages })`. The
  reply is the last AI message in the returned state. If they use a checkpointer
  with a `thread_id`, keep passing the full history anyway: Buildbox sends the
  whole conversation every turn and does not rely on their memory.
- **OpenAI Agents SDK (Python or JS).** `Runner.run(agent, input)` or
  `run(agent, input)`. The reply is `result.final_output`. The input accepts the
  message list directly.
- **Vercel AI SDK.** `generateText({ model, messages })` returns `{ text }`, and
  `streamText` returns a `textStream` you can pass straight through as an async
  iterable of strings. Their API route is usually a thin shell around one of
  these, and the call inside it is the seam, not the route.
- **A plain function or a class method.** Many agents are one function that
  builds a prompt and calls a model. Use it directly.
- **Only an HTTP route exists.** Do not call their own server over HTTP from the
  wrapper. Move the body of the route into a function, have the route call it,
  and have the wrapper call it too. If they refuse a refactor, and the route is
  reachable from where the bridge will run, they should use the endpoint
  connection on the Testing page instead of this recipe.

Confirm with the customer, in one sentence, which function you found before you
write anything.

## Step 2: install the bridge

Python:

```bash
pip install buildbox-bridge
```

Node:

```bash
npm install buildbox-bridge     # or use npx and install nothing
```

Match their environment. If the agent runs in a virtualenv, a container, or a
worker image, the bridge has to be installed in the same place the agent's code
can be imported from.

## Step 3: write the wrapper

One new file. It imports their function and exposes `reply`.

The contract, in both languages:

- Input `messages`: the conversation so far, oldest first, each one
  `{"role": "user" | "assistant" | "system", "content": "..."}`.
- Input `channel`: a label for the channel being exercised, one of `endpoint`,
  `sms`, `whatsapp`, `slack`, `email`, `telegram`. Pass it through if their agent
  behaves differently per channel; ignore it otherwise.
- Optional input `sender`: the identity Buildbox uses for the test turn, such as
  `buildbox-testing`. Python wrappers may declare `sender=None`; JavaScript
  wrappers may omit the third parameter when they do not use it.
- Return: a string, a list of strings (when the agent sends several messages),
  or an iterator or async iterator of strings (when the agent streams). Returning
  nothing is legal and Buildbox reads it as silence.

Python, `buildbox_wrapper.py` at their repo root:

```python
from myapp.agent import run_agent  # the function you found in step 1


def reply(messages, channel, sender=None):
    result = run_agent(messages)
    return result.text
```

LangGraph, Python:

```python
from myapp.graph import graph


def reply(messages, channel):
    state = graph.invoke({"messages": messages})
    return state["messages"][-1].content
```

OpenAI Agents SDK, Python:

```python
from agents import Runner

from myapp.agent import support_agent


async def reply(messages, channel):
    result = await Runner.run(support_agent, messages)
    return result.final_output
```

Node, `buildbox-wrapper.mjs` at their repo root:

```js
import { runAgent } from "./src/agent.js"; // the function you found in step 1

export function reply(messages, channel, sender) {
  return runAgent(messages);
}
```

Vercel AI SDK, streaming each chunk as it is produced:

```js
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function* reply(messages, channel) {
  const result = streamText({ model: openai("gpt-4o"), messages });
  yield* result.textStream;
}
```

LangGraph, JS:

```js
import { graph } from "./src/graph.js";

export async function reply(messages, channel) {
  const state = await graph.invoke({ messages });
  return state.messages.at(-1).content;
}
```

Three mistakes to avoid, all of which pass a self-test and fail a real run:

- Using only the last message. Pass the whole `messages` list.
- Returning the framework's result object instead of the text. Return the text.
- Creating a new session per turn when their agent is stateful. Buildbox sends
  the full history every turn, so build the agent's state from `messages`, not
  from a session id you invent.

## Step 4: run the self-test

```bash
buildbox-bridge selftest --target buildbox_wrapper:reply          # Python
npx buildbox-bridge selftest --target ./buildbox-wrapper.mjs:reply  # Node
```

This calls the wrapper with a canned three-message conversation and checks the
shape of what comes back. It makes no network connection and needs no key.

Exit codes: `0` passed, `2` the target could not be loaded, `3` the wrapper
returned something that cannot be sent, or it raised. Add `--show` to print the
replies while debugging; they stay on the customer's machine.

Do not go on until this passes.

## Step 5: start the connector

The key is on the Buildbox Testing page, under the connector option, and it is
shown once. The customer exports it themselves:

```bash
export BUILDBOX_CONNECTOR_KEY=bbx_connector_...
```

Then start the bridge:

```bash
buildbox-bridge connect --target buildbox_wrapper:reply             # Python
npx buildbox-bridge connect --target ./buildbox-wrapper.mjs:reply   # Node
```

It prints one line per event, for example:

```
buildbox-bridge: connected to Buildbox Testing over websocket as dev-laptop
buildbox-bridge: turn t_8fa1 on channel endpoint: 1 reply(ies) sent
```

Leave it running for the length of a test run. Useful flags: `--label <name>` to
name this instance on the Testing page (the hostname by default),
`--max-concurrent-turns <n>` to cap how many turns their agent answers at once
(8 by default), `--server <url>` when they are pointed at a Buildbox other than
production.

For a repeatable setup, run the same command as a service next to their agent
(a container, a systemd unit, a worker process) with the key in their secret
store. Only one connector is live per testing connection: when a second one
connects, the older one is told to stop and exits. That is how a laptop trial is
replaced by an infrastructure instance without anyone editing anything.

## Step 6: confirm it on the Testing page

Ask the customer to open the Buildbox Testing page. The connector shows as
connected, with the instance label and the time it was last seen. Then have them
start a test run and watch a conversation complete.

Setup is done when the Testing page shows the connector connected AND one test
conversation has replies in it. A connected bridge that answers nothing is not
finished; go back to step 4 and check the wrapper against their real agent.

## When it does not work, in this order

- **`no connector key`**: `BUILDBOX_CONNECTOR_KEY` is not set in the shell that
  runs the bridge. Exporting it in another tab does not count.
- **`connector key was not accepted`**, and the bridge exits: the key is wrong,
  or it was revoked or rotated on the Testing page. Mint a new one there. The
  bridge deliberately does not retry a rejected key.
- **`falling back to polling on the same contract`**: the network will not hold
  a websocket, usually a proxy. Nothing to fix. The bridge keeps working on the
  polling routes and retries the websocket later.
- **`reconnecting in ...s`, repeatedly**: Buildbox is unreachable from that
  machine. Check outbound HTTPS to the server URL.
- **`turn ... raised <ErrorType> inside your reply() function`**: their code
  raised. The bridge deliberately does not print the error message, because it
  can contain conversation text. Run the self-test to see it in full.
- **`turn ... hit its ...ms deadline`**: their agent took longer than the run
  allows. Time the same input outside the bridge before blaming the connection.
- **The Testing page still says not connected**: check the bridge printed
  `connected`, and that the key came from the same workspace the page is showing.
- **The run reports silence**: the wrapper returned nothing. That is a real
  finding if their agent really says nothing, and a wrapper bug if it does not.
  Self-test with `--show` to tell them apart.

## What the bridge does and does not do

- It makes outbound connections only, and never listens on a port.
- It reads the key from the environment and never writes it anywhere.
- It never logs message content: status lines carry turn ids, counts, channel
  labels, and reasons.
- It does not send their production traffic to Buildbox. That is the trace
  setup in the main `SKILL.md`, and it is a separate decision.
