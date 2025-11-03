// src/server.ts
import "dotenv/config";
import express from "express";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { ClientMessageSchema } from "./types.js";

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.VOICE || "alloy";
const OUTPUT_AUDIO_FORMAT = process.env.OUTPUT_AUDIO_FORMAT || "opus";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in env");
  process.exit(1);
}

const app = express();
app.get("/health", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// WebSocket endpoint your frontend connects to: wss://<host>/ws/voice
const wss = new WebSocketServer({ noServer: true });

function checkClientAuth(_req: http.IncomingMessage): boolean {
  // TODO: add your own auth (cookies/JWT/API token, etc.)
  return true;
}

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws/voice") || !checkClientAuth(req)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", async (client: WebSocket) => {
  // Connect upstream to OpenAI Realtime API (WebSocket)
  const upstream = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let closed = false;

  const closeBoth = (code = 1000, reason = "closing") => {
    if (closed) return;
    closed = true;
    try {
      upstream.close(code, reason);
    } catch {}
    try {
      client.close(code, reason);
    } catch {}
  };

  // Keep-alive ping to browser client
  const pingInterval = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  }, 30_000);

  client.on("close", () => {
    clearInterval(pingInterval);
    closeBoth();
  });
  client.on("error", () => closeBoth(1011, "client error"));

  upstream.on("close", () => closeBoth());
  upstream.on("error", (err) => {
    safeSend(client, { type: "error", message: "upstream error", details: String(err) });
    closeBoth(1011, "upstream error");
  });

  // When upstream is ready, configure session defaults
  upstream.on("open", () => {
    // Server-side session config: modalities, server VAD, voice, audio format
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions:
          "You are a concise, helpful voice assistant. Keep answers short when possible.",
        modalities: ["audio", "text"],
        // Server VAD: model detects end-of-speech and auto-creates responses
        turn_detection: { type: "server_vad", silence_duration_ms: 500 },
        voice: VOICE,
        output_audio_format: OUTPUT_AUDIO_FORMAT,
      },
    };
    upstream.send(JSON.stringify(sessionUpdate));
    safeSend(client, { type: "ready", sessionId: randomId("sess_") });
  });

  // FORWARD: Browser -> OpenAI
  client.on("message", (data, isBinary) => {
    // Binary frames are raw audio (e.g., PCM16/Opus). Convert to base64 and append to input buffer.
    if (isBinary) {
      const base64 = Buffer.from(data as Buffer).toString("base64");
      upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
      return;
    }

    // Text frames are JSON control messages
    let parsed: unknown;
    try {
      parsed = JSON.parse((data as Buffer).toString("utf8"));
    } catch {
      safeSend(client, { type: "error", message: "Invalid JSON from client" });
      return;
    }

    const result = ClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      safeSend(client, {
        type: "error",
        message: "Invalid message shape",
        details: result.error.format(),
      });
      return;
    }

    const msg = result.data;

    switch (msg.type) {
      case "session.init": {
        if (msg.instructions) {
          upstream.send(
            JSON.stringify({
              type: "session.update",
              session: { instructions: msg.instructions },
            })
          );
        }
        break;
      }

      case "interrupt": {
        // Stop any ongoing model speech/output
        upstream.send(JSON.stringify({ type: "response.cancel" }));
        break;
      }

      case "commit": {
        // If you disable server VAD, you can force a commit + (optionally) trigger a response here.
        upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        // upstream.send(JSON.stringify({ type: "response.create" }));
        break;
      }

      case "response.create": {
        // Pass-through with sensible audio defaults
        const payload = {
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            voice: VOICE,
            output_audio_format: OUTPUT_AUDIO_FORMAT,
            ...(msg.response ?? {}),
          },
        };
        upstream.send(JSON.stringify(payload));
        break;
      }

      case "session.update": {
        upstream.send(JSON.stringify({ type: "session.update", session: msg.session }));
        break;
      }

      default: {
        // Future-proof: pass other messages through
        upstream.send(JSON.stringify(msg));
      }
    }
  });

  // FORWARD: OpenAI -> Browser
  upstream.on("message", (raw) => {
    // Realtime emits JSON frames. Audio comes as response.audio.delta chunks (base64 payloads).
    try {
      client.send(raw, { binary: false });
    } catch {
      // client gone
    }
  });
});

server.listen(PORT, () => {
  console.log(`voice backend listening on :${PORT}`);
});

// ---------- utils ----------
function safeSend(ws: WebSocket, obj: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function randomId(prefix = ""): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}
