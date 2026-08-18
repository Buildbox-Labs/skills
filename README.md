# Buildbox skills

Agent skills for connecting your product to [Buildbox](https://heybuildbox.com), agent
analytics for real user outcomes. Buildbox reads the conversations your agent already
produces and reports where real customer jobs fail, with the evidence attached.

## buildbox

Connects your AI agent to Buildbox over standard OpenTelemetry. Your coding agent
follows the skill: it detects your framework, writes plain OTel configuration (there is
no Buildbox SDK to install), and keeps going until a real interaction from your running
app shows up on your Buildbox setup screen.

The quickest path is the one command your Buildbox setup screen gives you (Setup, then
Direct feed, then "Connect with my coding agent"). It installs this skill and starts your
agent with a one-use pairing code; the agent trades the code for the ingest key and writes
it straight into your app's environment file, so neither you nor the agent ever handles
the key. It looks like this:

```bash
npx -y skills add Buildbox-Labs/skills --skill buildbox -a claude-code -y && \
  claude "Use the buildbox skill to connect this app to Buildbox. Endpoint: ... Pairing code: bbx_pair_..."
```

To install the skill on its own:

```bash
npx skills add Buildbox-Labs/skills --skill buildbox
```

Then, in your coding agent:

```text
Use the buildbox skill to connect my agent to Buildbox.
```

Without a pairing code, the skill asks you to paste the endpoint and ingest key from your
Buildbox setup screen into your app's environment file yourself. The key is shown once,
and the skill is written so your coding agent never sees it.

Works with the Vercel AI SDK, OpenAI Agents, LangChain and LangGraph, bare OpenAI or
Anthropic clients, and any app already instrumented with OpenTelemetry.
