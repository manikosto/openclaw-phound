import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { listConnectedAccountIds, listPhoundContacts, placePhoundCall } from "./gateway.js";
import { findCall, listCalls } from "./voice/call-session.js";

const PhoundCallSchema = Type.Object({
  to: Type.String({
    description: "A contact's name (see phound_contacts), or a phone number in E.164 format (+15551234567)",
  }),
  message: Type.String({ description: "The first sentence you say when the call is answered" }),
  purpose: Type.Optional(
    Type.String({ description: "Why you are calling; kept in your context during the call" }),
  ),
  accountId: Type.Optional(Type.String({ description: "Phound account to call from" })),
});

const PhoundContactsSchema = Type.Object({
  accountId: Type.Optional(Type.String({ description: "Phound account whose contacts to list" })),
});

const PhoundHangupSchema = Type.Object({
  callId: Type.Optional(Type.String({ description: "Call to end; defaults to the call you are on" })),
});

function resolveAccountId(requested?: string): string {
  const connected = listConnectedAccountIds();
  if (requested) {
    if (!connected.includes(requested)) {
      throw new Error(`Phound account "${requested}" is not connected`);
    }
    return requested;
  }
  if (connected.length === 0) {
    throw new Error("No Phound account is connected");
  }
  return connected[0]!;
}

export function registerPhoundTools(api: OpenClawPluginApi): void {
  api.registerTool({
    name: "phound_call",
    label: "Phound Call",
    description:
      "Phone someone through Phound and talk with them by voice. Your contacts (phound_contacts) and people who may chat with you get a full conversation; anyone else hears your message and the call ends.",
    parameters: PhoundCallSchema,
    async execute(_toolCallId, params) {
      const { to, message, purpose, accountId } = params as {
        to: string;
        message: string;
        purpose?: string;
        accountId?: string;
      };
      const result = await placePhoundCall({
        accountId: resolveAccountId(accountId),
        to,
        opening: message,
        purpose,
      });
      return jsonResult({
        status: "dialling",
        to: result.name ?? result.number,
        mode: result.conversational ? "conversation" : "notify",
      });
    },
  });

  api.registerTool({
    name: "phound_contacts",
    label: "Phound Contacts",
    description: "List the contacts you may call by name with phound_call, with a note about each. Their numbers are not shown.",
    parameters: PhoundContactsSchema,
    async execute(_toolCallId, params) {
      const { accountId } = params as { accountId?: string };
      const contacts = listPhoundContacts(resolveAccountId(accountId));
      // Names are enough to call; the numbers stay out of the agent's context.
      return jsonResult({ contacts: contacts.map(({ name, note }) => ({ name, ...(note ? { note } : {}) })) });
    },
  });

  api.registerTool((toolContext) => ({
    name: "phound_hangup",
    label: "Phound Hang Up",
    description: "End the Phound phone call you are on, after your last words have been spoken.",
    parameters: PhoundHangupSchema,
    async execute(_toolCallId, params) {
      const { callId } = params as { callId?: string };
      const call = findCall({ callId, sessionKey: toolContext.sessionKey });
      if (!call) {
        return jsonResult({
          status: "no-call",
          activeCalls: listCalls().map((c) => c.callId),
        });
      }
      void call.hangup();
      return jsonResult({ status: "hanging-up", callId: call.callId });
    },
  }), { name: "phound_hangup" });
}
