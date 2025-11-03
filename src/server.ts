// src/server.ts
import express from "express";
import http from "http";
import cors from "cors";
import WebSocket, { WebSocketServer } from "ws";
import { TOOL_DEFS, sendEmailViaGmail, postWebhook } from "./tools";

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// Optional: choose the realtime model you’re using
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";

// ---------- Express HTTP (health checks, etc.) ----------
const app = express();
app.use(cors());
app.get("/", (_req, res) => res.status(200).send("voice backend up"));
const server = http.createServer(app);

// ---------- Helpers ----------
type Pending = string | ArrayBufferLike | ArrayBufferView;

function queueingSend(ws: WebSocket) {
  const q: Pending[] = [];
  let open = ws.readyState === WebSocket.OPEN;

  function flush() {
    if (!open) return;
    while (q.length) {
      const item = q.shift()!;
      try { ws.send(item); } catch (e) { console.warn("send error:", e); break; }
    }
  }
  ws.on("open", () => { open = true; flush(); });
  ws.on("close", () => { open = false; });
  return (data: Pending) => {
    if (open) {
      try { ws.send(data); } catch { q.push(data); }
    } else {
      q.push(data);
    }
  };
}

// Track function-call argument streaming per response
type CallBuf = { name: string; argsJson: string };
const funcArgBuffers = new WeakMap<WebSocket, Map<string, CallBuf>>();

// ---------- WebSocket (browser <-> server) ----------
const wss = new WebSocketServer({ server, path: "/ws/voice" });

wss.on("connection", (clientWs) => {
  console.log("client connected");

  // --- Connect to OpenAI Realtime WS ---
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  const sendToClient = queueingSend(clientWs);
  const sendToOpenAI = queueingSend(openaiWs);

  // per-connection buffer map
  funcArgBuffers.set(openaiWs, new Map());

  // When OpenAI opens, configure the session (VAD + tools)
  openaiWs.on("open", () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions:
          "You are a concise voice assistant. If the user asks to send an email or to post JSON to a webhook, call a function. " +
          "Always confirm the recipient and subject before sending an email. Keep voice replies short.",
        modalities: ["audio", "text"],
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        voice: "alloy",
        // Add tools
        tools: TOOL_DEFS,
        tool_choice: "auto",
        // Hands-free VAD
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
          interrupt_response: true
        }
      }
    };
    sendToOpenAI(JSON.stringify(sessionUpdate));
  });

  // Relay OpenAI -> Client
  openaiWs.on("message", async (data) => {
    // Forward raw text events to client (they’re already JSON strings)
    if (typeof data === "string") {
      // Intercept tool-calling events and run tools server-side
      try {
        const msg = JSON.parse(data);

        // 1) a function call started: remember call_id and name
        if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
          const map = funcArgBuffers.get(openaiWs)!;
          map.set(msg.item.call_id, { name: msg.item.name, argsJson: "" });
        }

        // 2) function args stream in
        if (msg.type === "response.function_call_arguments.delta") {
          const map = funcArgBuffers.get(openaiWs)!;
          const buf = map.get(msg.call_id);
          if (buf) buf.argsJson += (msg.delta ?? "");
        }

        // 3) function args complete -> execute and return
        if (msg.type === "response.function_call_arguments.done") {
          const map = funcArgBuffers.get(openaiWs)!;
          const buf = map.get(msg.call_id);
          if (buf) {
            (async () => {
              let toolOutput: any;
              try {
                const args = buf.argsJson ? JSON.parse(buf.argsJson) : {};
                if (buf.name === "send_email") {
                  toolOutput = await sendEmailViaGmail(args);
                } else if (buf.name === "post_webhook") {
                  toolOutput = await postWebhook(args);
                } else {
                  toolOutput = { error: `Unknown tool: ${buf.name}` };
                }
              } catch (e: any) {
                toolOutput = { error: String(e?.message || e) };
              }

              // Feed tool result into the conversation
              sendToOpenAI(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: msg.call_id,
                  output: JSON.stringify(toolOutput)
                }
              }));

              // Ask model to continue (speak a confirmation)
              sendToOpenAI(JSON.stringify({ type: "response.create", response: {} }));

              map.delete(msg.call_id);
            })();
          }
        }
      } catch {
        // fallthrough
      }

      // Always forward to the browser too (so your UI log sees everything)
      return sendToClient(data);
    }

    // If OpenAI sends binary (rare), forward it
    return sendToClient(data as Buffer);
  });

  openaiWs.on("close", (code, reason) => {
    console.log("openai closed:", code, reason.toString());
    try { clientWs.close(1011, "upstream closed"); } catch {}
  });
  openaiWs.on("error", (err) => console.error("openai ws error:", err));

  // Relay Client -> OpenAI
  clientWs.on("message", (data, isBinary) => {
    // Client may send:
    // - binary PCM16 frames (we forward directly)
    // - JSON control messages: response.create, interrupt, etc.
    if (isBinary) {
      return sendToOpenAI(data as Buffer);
    }
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "interrupt") {
        // cut off the model immediately
        sendToOpenAI(JSON.stringify({ type: "response.cancel" }));
        // also clear any pending input buffer
        sendToOpenAI(JSON.stringify({ type: "input_audio_buffer.clear" }));
        return;
      }

      // Allow passthrough for response.create, session.update, etc.
      return sendToOpenAI(JSON.stringify(msg));
    } catch {
      // not JSON -> ignore
    }
  });

  clientWs.on("close", () => {
    try { openaiWs.close(1000, "client left"); } catch {}
  });
  clientWs.on("error", (err) => console.error("client ws error:", err));

  // Let the frontend know it can start
  sendToClient(JSON.stringify({ type: "ready", sessionId: `sess_${Math.random().toString(36).slice(2)}` }));
});

// ---------- Start ----------
server.listen(PORT, () => {
  console.log(`voice backend listening on :${PORT}`);
});
