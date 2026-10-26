# Phound channel for OpenClaw

An OpenClaw channel plugin that puts your agent on [Phound](https://phound.app). The agent runs as a Phound bot persona, and people reach it three ways:

- **Phound app chat.** Write to the persona. Replies render as markdown.
- **SMS.** People with no Phound account text the persona's number. Replies go back as plain text.
- **Phone calls.** Call the persona and talk. The agent can also call people with the `phound_call` tool.

It works like the Telegram channel: unknown senders get a pairing code, and approved people get a session with the agent.

**The plugin is only a transport.** It carries messages and call audio between Phound and OpenClaw and runs no AI of its own:

- **Chat and SMS.** Messages go to the agent as they are. Voice messages arrive as audio attachments, and OpenClaw transcribes them itself (`tools.media`).
- **Calls.** Audio is bridged to **OpenClaw's own voice engine**, the realtime voice runtime its Discord voice channel uses. The engine listens, speaks, handles barge-in, and hands real work to the routed agent (`openclaw_agent_consult`) with that agent's persona and tools.

```
Phound platform ── uccrobot ── bridge/phound_bridge.py (Phound SDK, Python)
                                   │  JSON lines over stdio
                                   ▼
OpenClaw gateway ── phound plugin (TypeScript, transport only)
                     ├─ chat / SMS / voice message ──► agent turn ──► reply into the same chat
                     └─ call: PCM 16 kHz websocket ◄──► resample 16 ↔ 24 kHz, 20 ms pacing
                                                         ▲
                                                         ▼
                                     OpenClaw voice engine (talk.realtime) ──► agent consult
```

## Requirements

| Requirement | Details |
|---|---|
| **OpenClaw** | 2026.10.7, which needs Node ≥ 24.22.1. See [Compatibility](#compatibility). |
| **Python** | 3.11 or later, with [uv](https://docs.astral.sh/uv/). The plugin runs the bridge with `uv run`, and uv installs the `phound` SDK on first start. To use your own interpreter instead, set `pythonCommand` and `pip install phound`. |
| **Phound bot token** | Ask the **Support Bot** at the bottom of the Home page in the Phound app. It replies with `TOKEN` and `PERSONAS`. |
| **Calls to phone numbers** | Must be enabled for the Phound account. Ask Phound support. |
| **OpenClaw realtime voice** | Needed for calls: `talk.realtime.provider` (for example `openai`) with its API key. |
| **OpenClaw audio understanding** | Needed for voice messages: an audio model under `tools.media`, for example OpenAI `gpt-4o-transcribe`. |

## Install

```bash
openclaw plugins install clawhub:openclaw-phound --accept-capabilities
```

Or, from a checkout of this repository: `openclaw plugins install --link /path/to/openclaw-phound --accept-capabilities`.

## Configure

Set the token and persona from the Support Bot's reply:

```bash
openclaw channels add phound --token <TOKEN> --persona-uid <PERSONAS>
```

The same fields are in the channel's settings form in the Control UI. The full set, in `~/.openclaw/openclaw.json` (JSON5):

```json5
{
  channels: {
    phound: {
      token: "<bot token>",          // or env PHOUND_TOKEN
      personaUid: "<persona uid>",   // the persona the bot answers as, and writes and calls from
      sbc: "",                       // Phound server; empty = production. Set it (or env PHOUND_SBC) for a QA stand
      dmPolicy: "pairing",           // pairing | allowlist | open | disabled
      allowFrom: ["+15551234567", "123456789012"],   // +E.164 phone numbers, or Phound persona uids
      voice: {
        enabled: true,               // answer calls (default true)
        greeting: "",                // how to greet, as an instruction to the voice engine
        toolPolicy: "safe-read-only",// agent tools for callers from the Phound app: safe-read-only | owner | none
        phoneToolPolicy: "none",     // the same for callers from a phone number (caller ID can be spoofed)
        callPolicy: "allowlist",     // phound_call dials only people allowed to talk to the agent...
        callAllow: [],               // ...plus these numbers; "any" lets it dial anyone, at your cost
      },
    },
  },

  // OpenClaw's voice engine for calls.
  talk: { realtime: { provider: "openai", model: "gpt-realtime-2.1" } },
  // OpenClaw's audio understanding for voice messages.
  tools: { media: { models: [{ provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] }] } },
  // One session per person instead of one shared DM session.
  session: { dmScope: "per-channel-peer" },
}
```

A phone number is always written with its leading `+`. Bare digits are a Phound persona uid.

### Pairing

1. A new person writes to the persona and gets a pairing code.
2. Approve it with `openclaw pairing approve phound <code>`.
3. They can then chat, and their calls are answered.

Calls from people who have not been approved are rejected. Nobody can pair over voice.

**Caller ID is not identity.** A phone number on an incoming call can be spoofed, so a call from an allowed number only gets in the door:

- It runs in its own session (`call:+1555…`), not in that number's SMS session.
- It gets no command-owner rights.
- By default it gets none of the agent's tools: no files, memory or web (`voice.phoneToolPolicy`).

Calls from the Phound app come from a persona that Phound itself authenticates, so they share that person's chat session and get `voice.toolPolicy`.

## A persona to talk to

The Phound persona is *who* people reach; the OpenClaw agent behind it is *who answers*. An agent is a workspace with `SOUL.md` (character, tone) and `IDENTITY.md` (name, vibe). On calls, OpenClaw's voice engine reads them too, so the voice is the same persona. Route Phound to a dedicated agent with a binding:

```json5
{
  agents: {
    entries: {
      main: { workspace: "~/.openclaw/workspace" },
      ava:  { workspace: "~/.openclaw/workspace-ava" },   // SOUL.md / IDENTITY.md for "Ava"
    },
  },
  bindings: [
    { agentId: "ava", match: { channel: "phound" } },
  ],
}
```

For several personas with different characters, give each its own Phound token as a separate account under `channels.phound.accounts.<id>`. Then bind each one with `match: { channel: "phound", accountId: "<id>" }`.

## What the agent can do

| | |
|---|---|
| Reply in Phound chats and SMS | automatic: the reply goes back to the chat the message came from |
| Message proactively | `message` tool with `channel: "phound"` and a target: `chat:<chatId>`, `persona:<personaUid>`, or a `+E.164` number |
| Call someone | `phound_call` with `to`, `message` (opening line), and optional `purpose`. Only numbers allowed by `voice.callPolicy` |
| End a call | the voice engine hangs up after saying goodbye; `phound_hangup` ends a call from a chat turn |

On `phound_call`, numbers that may talk to the agent get a full conversation. Any other allowed number hears the opening line, and then the call ends.

## Run in Docker

The image is the official `ghcr.io/openclaw/openclaw:2026.10.7` plus Python, the bridge's Phound SDK, and this plugin. It is built for `linux/amd64` because the Phound SDK ships its binary for linux x86_64 only. On Apple Silicon, Docker runs it under emulation.

1. Create a `.env` file next to `docker-compose.yml`. It is gitignored.

   ```
   OPENAI_API_KEY=...   # agent model, voice engine, voice-message transcription
   PHOUND_TOKEN=...     # bot token from the Phound Support Bot
   PHOUND_SBC=...       # optional: a QA stand's server; the token must be issued on that stand
   ```

2. Start the container and follow its log:

   ```bash
   docker compose up -d --build
   docker compose logs -f openclaw
   ```

3. Set the persona, and approve people who pair with the bot:

   ```bash
   docker compose exec openclaw node /app/openclaw.mjs config set channels.phound.personaUid '"<PERSONAS>"'
   docker compose exec openclaw node /app/openclaw.mjs pairing approve phound <code>
   ```

On first start, `docker/start.sh` links the plugin and applies `docker/settings.json`. The settings cover:

- OpenAI realtime for calls and `gpt-4o-transcribe` for voice messages;
- one session per person;
- pairing for new people;
- the gateway bound to loopback inside the container. No ports are published, because the bridge itself connects out to Phound.

State lives in the `openclaw-state` volume.

## Compatibility

Calls use OpenClaw's voice engine through `openclaw/plugin-sdk/realtime-voice`. OpenClaw ships that SDK surface for its own channel plugins and marks it private-local, without type declarations. This plugin declares the few types it uses in `src/voice/openclaw-voice.d.ts` and is tested against OpenClaw 2026.10.7. A later OpenClaw release can change that surface, so check calls after upgrading OpenClaw.

## Limits of this version

- **Texting a phone number.** The agent can text a number only after a conversation with it (an SMS or a call) since the gateway started. The Phound SDK cannot look a number up outside a live chat. Persona uids and chat ids always work.
- **Chat types.** Only one-to-one chats are handled; group chats are ignored.
- **Attachments.** Incoming attachments other than voice messages reach the agent as links. Outgoing media is not sent.

## Develop

```bash
npm install
npm run typecheck
npm test               # the bridge protocol against a fake Phound SDK, the call transport, policies
npm run build          # dist/, what the published package runs
npm run gen:manifest   # after changing src/config-schema.ts
```

`test/fake_phound` is a stand-in for the Phound SDK. Put it on `PYTHONPATH` and set `pythonCommand: ["python3"]` to run the whole plugin in a real gateway without a Phound account. `PHOUND_DEBUG_AUDIO_DIR` makes the plugin write each call's raw audio, in both directions, to that folder.

## License

MIT
