# Buildbox skills

Agent skills for connecting your product to [Buildbox](https://heybuildbox.com), agent
analytics for real user outcomes. Buildbox reads the conversations your agent already
produces and reports where real customer jobs fail, with the evidence attached.

## buildbox

Connects your AI agent to Buildbox over standard OpenTelemetry. Your coding agent
follows the skill: it detects your framework, writes plain OTel configuration (there is
no Buildbox SDK to install), and keeps going until a real interaction from your running
app shows up on your Buildbox setup screen.

```bash
npx skills add Buildbox-Labs/skills --skill buildbox
```

Then, in your coding agent:

```text
Use the buildbox skill to connect my agent to Buildbox.
```

You will need the endpoint and ingest key from your Buildbox setup screen (Setup, then
Direct feed). The key is shown once and belongs in your app's environment file; the
skill is written so your coding agent never sees it.

Works with the Vercel AI SDK, OpenAI Agents, LangChain and LangGraph, bare OpenAI or
Anthropic clients, and any app already instrumented with OpenTelemetry.
