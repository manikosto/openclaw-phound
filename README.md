<p align="center">
  <img src="https://raw.githubusercontent.com/manikosto/openclaw-phound/main/assets/icon.png" alt="Phound" width="120">
</p>

<h1 align="center">Phound for OpenClaw</h1>

<p align="center">Chat, text and call your OpenClaw agent through <a href="https://phound.app">Phound</a>.</p>

---

Your agent gets a Phound persona with its own number. People reach it the way they reach anyone else:

- **Phound app chat.** Write to the persona. Replies come back formatted.
- **SMS.** Text the persona's number from any phone, no Phound account needed.
- **Voice messages.** Send one in the app. The agent understands it.
- **Phone calls.** Call the persona and talk to the agent live. The agent can call people too.

It works like the Telegram channel: unknown senders get a pairing code, and once you approve them they have their own conversation with the agent.

## Get started

**1. Get a bot token.** In the Phound app, open the **Support Bot** at the bottom of the Home page and ask for a bot token. It replies with `TOKEN` and `PERSONAS`.

**2. Install the plugin.**

```bash
openclaw plugins install clawhub:openclaw-phound --accept-capabilities
```

**3. Connect it.**

```bash
openclaw channels add phound --token <TOKEN> --persona-uid <PERSONAS>
```

The same fields are in the channel settings in the Control UI.

**4. Turn on voice** (for calls and voice messages), in `~/.openclaw/openclaw.json`:

```json5
{
  talk: { realtime: { provider: "openai", model: "gpt-realtime-2.1" } },
  tools: { media: { models: [{ provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] }] } },
  session: { dmScope: "per-channel-peer" },   // one conversation per person
}
```

**5. Say hi.** Write to the persona in Phound. You get a pairing code; approve it:

```bash
openclaw pairing approve phound <code>
```

Now chat, text or call.

### You will need

- **OpenClaw** 2026.10.7 or later.
- **Python** 3.11+ with [uv](https://docs.astral.sh/uv/). The plugin sets up the Phound SDK itself on first start.
- **Calls to phone numbers** enabled on the Phound account. Ask Phound support.

## What the agent can do

| | |
|---|---|
| **Reply** | Answers go back to the chat the message came from: formatted in the app, plain text over SMS. |
| **Message first** | The `message` tool with `channel: "phound"` and a target: `chat:<chatId>`, `persona:<personaUid>`, or a `+E.164` number. |
| **Call someone** | `phound_call` with `to` (a contact's name or a phone number), an opening line, and an optional purpose. Contacts and people the agent may talk to get a full conversation. |
| **Look up contacts** | `phound_contacts` lists who it may call by name. |
| **Hang up** | It says goodbye and hangs up on its own. `phound_hangup` ends a call from a chat. |

## Contacts

Write down the people the agent may call, and it calls them by name: "call Mom and ask when she lands".

```json5
{
  channels: {
    phound: {
      contacts: [
        { name: "Mom", number: "+15550001111", note: "Lands in Boston on Friday" },
        { name: "Dentist", number: "+15552223333", note: "Dr. Lee's office; I'm a patient" },
      ],
    },
  },
}
```

The same list is under **Contacts** in the channel settings in the Control UI. The note is what the agent knows about the person on the call. Being a contact lets the agent call someone; it does not let them write to the agent. That still takes pairing.

## Give it a character

The Phound persona is *who* people reach; the OpenClaw agent behind it is *who answers*. Give the agent a `SOUL.md` (character, tone) and an `IDENTITY.md` (name, vibe) and it keeps that character in chats and on calls. To put a dedicated agent on Phound:

```json5
{
  agents: {
    entries: {
      ava: { workspace: "~/.openclaw/workspace-ava" },   // SOUL.md / IDENTITY.md for "Ava"
    },
  },
  bindings: [{ agentId: "ava", match: { channel: "phound" } }],
}
```

For several characters, add one Phound token per character under `channels.phound.accounts.<id>` and bind each with `match: { channel: "phound", accountId: "<id>" }`.

## Settings

```json5
{
  channels: {
    phound: {
      token: "<bot token>",          // or env PHOUND_TOKEN
      personaUid: "<persona uid>",   // the persona the agent answers, writes and calls as
      dmPolicy: "pairing",           // pairing | allowlist | open | disabled
      allowFrom: ["+15551234567", "123456789012"],   // phone numbers with "+", or Phound persona uids
      contacts: [{ name: "Mom", number: "+15550001111", note: "" }],   // people the agent may call by name
      voice: {
        enabled: true,               // answer calls
        greeting: "",                // how to greet callers, e.g. "Greet them as Ava and ask what they need"
        toolPolicy: "safe-read-only",// agent tools on calls from the Phound app: safe-read-only | owner | none
        phoneToolPolicy: "none",     // the same for calls from phone numbers
        callPolicy: "allowlist",     // phound_call dials only contacts and approved people; "any" lets it dial anyone
        callAllow: [],               // extra numbers it may call just to deliver a message
      },
    },
  },
}
```

## Safety

- Only approved people can talk to the agent. Calls from anyone else are declined, and nobody can pair over a call.
- Caller ID can be faked, so a call from a phone number gets its own session, no owner rights and, by default, no agent tools. Calls from the Phound app are authenticated by Phound and share that person's chat.
- The agent calls only your contacts and approved people, unless you set `voice.callPolicy: "any"`. Calls cost money.
- On a call with a contact the agent uses `voice.phoneToolPolicy`: by default it talks, but does not touch its files, memory or tools.

## Run in Docker

The repository has a ready setup: the official OpenClaw image plus this plugin.

```bash
git clone https://github.com/manikosto/openclaw-phound && cd openclaw-phound
printf 'OPENAI_API_KEY=...\nPHOUND_TOKEN=...\n' > .env
docker compose up -d --build
docker compose exec openclaw node /app/openclaw.mjs config set channels.phound.personaUid '"<PERSONAS>"'
```

Approve people with `docker compose exec openclaw node /app/openclaw.mjs pairing approve phound <code>`.

## Good to know

- The agent can text a phone number after it has talked to that number (an SMS or a call). Persona uids and chats always work.
- Only one-to-one chats; group chats are ignored.
- Incoming files other than voice messages arrive as links. The agent sends text, not files.

## License

MIT
