import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { AnyClientMessage, ServerInfo } from "./types.js";

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

// --- WebSocket gateway for your frontend ---
const wss = new WebSocketServer({ noServer: true });

// Simple auth guard (optional): add your own token/cookie checks
function checkClientAuth(_req: http.IncomingMessage): boolean {
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
  // Open upstream connection to OpenAI Realtime API
  const upstream = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let closed = false;

  const closeBoth = (code = 1000, reason = "closing") => {
    if (closed) return;
    closed = true;
    try { upstream.close(code, reason); } catch {}
    try { client.close(code, reason); } catch {}
  };

  // Keep-alive pings to the browser
  const pingInterval = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  }, 30000);

  client.on("close", () => {
    clearInterval(pingInterval);
    closeBoth();
  });
  client.on("error", () => closeBoth(1011, "client error"));

  upstream.on("close", () => closeBoth());
  upstream.on("error", (err) => {
    const msg: ServerInfo = { type: "error", message: "upstream error", details: String(err) };
    safeSend(client, msg);
    closeBoth(1011, "upstream error");
  });

  // When upstream is ready, configure the session
  upstream.on("open", () => {
    // Configure the realtime session (server-side VAD, voice, modalities)
    // See OpenAI docs for session.update options incl. turn_detection and modalities. :contentReference[oaicite:3]{index=3}
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Global behavior
        instructions:
          "You are a concise, helpful voice assistant. Keep answers short when possible.",
        modalities: ["audio", "text"],
        // Enable server VAD so the model auto-creates responses when speech ends
        // (otherwise the client must send commit + response.create). :contentReference[oaicite:4]{index=4}
        turn_detection: { type: "server_vad", silence_duration_ms: 500 },
        // Output voice/audio settings (model-specific)
        voice: VOICE,
        output_audio_format: OUTPUT_AUDIO_FORMAT
      }
    };
    upstream.send(JSON.stringify(sessionUpdate as any));

    // Tell the browser we’re ready
    safeSend(client, { type: "ready", sessionId: randomId("sess_") });
  });

  // ---- FORWARD: browser -> OpenAI ----
  client.on("message", (data, isBinary) => {
    if (isBinary) {
      // Treat binary frames as raw PCM16/Opus etc. -> base64 -> append to input buffer
      const base64 = Buffer.from(data as Buffer).toString("base64");
      const append = { type: "input_audio_buffer.append", audio: base64 };
      // Client should periodically send these; OpenAI will VAD + transcribe + respond. :contentReference[oaicite:5]{index=5}
      upstream.send(JSON.stringify(append));
      return;
    }

    let msg: AnyClientMessage | undefined;
    try {
      msg = JSON.parse((data as Buffer).toString("utf8"));
    } catch {
      safeSend(client, { type: "error", message: "Invalid JSON from client" });
      return;
    }

    switch (msg.type) {
      case "session.init": {
        // Optional: override default instructions per connection
        if (msg.instructions) {
          upstream.send(
            JSON.stringify({
              type: "session.update",
              session: { instructions: msg.instructions }
            })
          );
        }
        break;
      }
      case "interrupt": {
        // Stop any ongoing generation/audio from the model
        // Use response.cancel as documented. :contentReference[oaicite:6]{index=6}
        upstream.send(JSON.stringify({ type: "response.cancel" }));
        break;
      }
      case "commit": {
        // If you’re NOT relying on server_vad, you can force a commit here.
        upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        // You can also choose to explicitly start a response:
        // upstream.send(JSON.stringify({ type: "response.create" }));
        break;
      }
      case "response.create": {
        // Pass-through, but ensure default audio modality/voice set if missing
        const payload = {
          type: "response.create",
          response: {
            modalities: ["audio", "text"],
            instructions: undefined,
            voice: VOICE,
            output_audio_format: OUTPUT_AUDIO_FORMAT,
            ...(msg.response || {})
          }
        };
        upstream.send(JSON.stringify(payload));
        break;
      }
      case "session.update": {
        upstream.send(JSON.stringify({ type: "session.update", session: msg.session }));
        break;
      }
      default: {
        // Pass unknown messages straight through (handy for tooling/function-calls later)
        upstream.send(JSON.stringify(msg));
      }
    }
  });

  // ---- FORWARD: OpenAI -> browser ----
  upstream.on("message", (raw) => {
    // OpenAI Realtime sends JSON frames containing server events.
    // Notably, the audio stream is provided in `response.audio.delta` events. :contentReference[oaicite:7]{index=7}
    // We forward frames as-is; your frontend can play audio deltas incrementally.
    try {
      client.send(raw, { binary: false });
    } catch {
      // ignore if client already gone
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
