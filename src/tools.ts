// src/tools.ts
import type WebSocket from "ws";
import { gmailSearch } from "./google";

// A tool definition that Realtime understands (JSON schema as "input_schema").
export type RealtimeToolDef = {
  type: "function";
  name: string;
  description: string;
  input_schema: Record<string, any>;
};

// Define the tools your agent can call.
export const TOOL_DEFS: RealtimeToolDef[] = [
  {
    type: "function",
    name: "gmail_search",
    description:
      "Search the user's Gmail. Use this when the user asks about their email. If unauthenticated, ask them to connect Gmail.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query (e.g., 'is:unread newer_than:3d')." },
        max: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

// Execute a specific tool by name with parsed arguments.
export async function runToolByName(name: string, args: any) {
  switch (name) {
    case "gmail_search":
      // Validate args gently
      return await gmailSearch({
        query: typeof args?.query === "string" ? args.query : "is:unread",
        max: typeof args?.max === "number" ? args.max : 5,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Helper: after we send a function_call_output, we MUST nudge the model to answer.
export function sendToolResultBackToModel(
  openaiWS: WebSocket,
  callId: string,
  resultObj: any
) {
  // 1) attach tool output to the conversation
  openaiWS.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(resultObj),
      },
    })
  );

  // 2) ask the model to respond using that tool output
  openaiWS.send(
    JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Use the tool result you just received to answer concisely.",
      },
    })
  );
}
