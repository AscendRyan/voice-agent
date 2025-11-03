// src/server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { installGoogleAuthRoutes } from "./google";
import { TOOL_DEFS, runToolByName, sendToolResultBackToModel } from "./tools";

// -------------------- Basic server setup --------------------
const app = express();
app.use(cors());
app.use(express.json());

installGoogleAuthRoutes(app);

const PORT = Number(process.env.PORT || 10000);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/voice" });

// -------------------- OpenAI (Realtime) config --------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const OPENAI_BASE = process.env.OPENAI_BASE || "wss://api.openai.com/v1/realtime";

// Default agent “personality” & behavior. You can tweak via env.
const DEFAULT_INSTRUCTIONS =
  process.env.AGENT_INSTRUCTIONS ||
  "You are a concise, friendly voice assistant. If a user asks about email, call the gmail_search tool. Keep responses short unless asked.";
const VOICE = process.env.AGENT_VOICE || "alloy";
const TEMP = Number(process.env.AGENT_TEMPERATURE || 0.7);

// ---- Helpers ----
function json(obj: any) {
  return JSON.stringify(obj);
}

// Track one session per browser client connection
wss.on("connection", async (clientWS: WebSocket) => {
  // 1) Open a WS to OpenAI Realtime for THIS client
  const url = `${OPENAI_BASE}?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const openaiWS = new WebSocket(url, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" },
  });

  // Buffers for tool calling (by call_id)
  const pendingToolCalls: Record<
    string,
    { name?: string; argsText: string }
  > = {};

  // Forward: client -> OpenAI (binary = PCM16 audio, JSON events)
  clientWS.on("message", (data) => {
    // Just tunnel through
    openaiWS.readyState === WebSocket.OPEN
      ? openaiWS.send(data)
      : console.warn("OpenAI WS not ready yet.");
  });

  // Forward: OpenAI -> client, and intercept tool-call events
  openaiWS.on("message", async (raw) => {
    try {
      // The server sends both JSON events and (sometimes) audio binary framed as JSON base64.
      const msg = JSON.parse(raw.toString());

      // --- TOOL CALL: detect the function call item and argument streaming ----
      // 1) When a function call item is added, record tool name + call_id
      if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
        const callId = msg.item?.call_id || msg.item?.id;
        if (callId) {
          pendingToolCalls[callId] = {
            name: msg.item?.name,
            argsText: "",
          };
        }
      }

      // 2) As arguments stream in, accumulate them by call_id
      if (msg.type === "response.function_call.arguments.delta") {
        const callId = msg.call_id || msg.item_id || msg.id;
        const delta = msg.delta || msg.arguments_delta || "";
        if (callId && pendingToolCalls[callId]) {
          pendingToolCalls[callId].argsText += String(delta);
        }
      }

      // 3) When arguments are done (or the function_call item completes), execute the tool
      if (
        msg.type === "response.function_call.arguments.done" ||
        (msg.type === "response.output_item.done" && msg.item?.type === "function_call")
      ) {
        const callId = msg.call_id || msg.item?.call_id || msg.item_id || msg.id;
        const entry = callId ? pendingToolCalls[callId] : undefined;

        if (callId && entry && entry.name) {
          let parsedArgs: any = {};
          try {
            parsedArgs = entry.argsText ? JSON.parse(entry.argsText) : {};
          } catch {
            // if the model produced slightly invalid JSON, ignore/empty
            parsedArgs = {};
          }

          try {
            const result = await runToolByName(entry.name, parsedArgs);
            // send tool result back to the model, then nudge it to answer
            sendToolResultBackToModel(openaiWS, callId, result);
          } catch (toolErr: any) {
            // Send an error as tool output so the model can gracefully explain
            sendToolResultBackToModel(openaiWS, callId, {
              error: true,
              message: toolErr?.message || String(toolErr),
            });
          } finally {
            delete pendingToolCalls[callId];
          }
        }
      }

      // Always forward the event to the browser client so your UI keeps working
      clientWS.readyState === WebSocket.OPEN && clientWS.send(raw);
    } catch {
      // If it's not JSON, just forward as-is (shouldn’t happen in our current setup)
      clientWS.readyState === WebSocket.OPEN && clientWS.send(raw);
    }
  });

  // When OpenAI WS opens, configure the session (add tools + voice, etc.)
  openaiWS.on("open", () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: DEFAULT_INSTRUCTIONS,
        voice: VOICE,
        temperature: TEMP,
        tool_choice: "auto",
        // Tell the model what tools exist
        tools: TOOL_DEFS,
        // Audio formats you already use
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        // Server VAD is fine to keep
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
          interrupt_response: true,
        },
      },
    };
    openaiWS.send(json(sessionUpdate));
    // Tell the browser we're ready
    clientWS.readyState === WebSocket.OPEN &&
      clientWS.send(json({ type: "ready", sessionId: "sess_" + Math.random().toString(36).slice(2) }));
  });

  const closeBoth = () => {
    try { openaiWS.close(); } catch {}
    try { clientWS.close(); } catch {}
  };
  openaiWS.on("close", closeBoth);
  openaiWS.on("error", closeBoth);
  clientWS.on("close", closeBoth);
  clientWS.on("error", closeBoth);
});

app.get("/", (_req, res) => {
  res.send("Voice backend with Gmail tool is running.");
});

server.listen(PORT, () => {
  console.log(`voice backend listening on :${PORT}`);
});
