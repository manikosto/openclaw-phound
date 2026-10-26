import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { listConnectedAccountIds, placePhoundCall } from "./gateway.js";
import { findCall, listCalls } from "./voice/call-session.js";

const PhoundCallSchema = Type.Object({
  to: Type.String({ description: "Phone number to call, in E.164 format (+15551234567)" }),
  message: Type.String({ description: "The first sentence you say when the call is answered" }),
  purpose: Type.Optional(
    Type.String({ description: "Why you are calling; kept in your context during the call" }),
  ),
  accountId: Type.Optional(Type.String({ description: "Phound account to call from" })),
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
      "Phone someone through Phound and talk with them by voice. Callers who may chat with you get a full conversation; anyone else hears your message and the call ends.",
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
        to: result.number,
        mode: result.conversational ? "conversation" : "notify",
      });
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
