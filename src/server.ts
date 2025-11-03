// src/server.ts
import http from "http";
import express from "express";
import cors from "cors";
import WebSocket, { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-realtime";
const OUTPUT_AUDIO_FORMAT = process.env.OUTPUT_AUDIO_FORMAT || "pcm16";
const INPUT_AUDIO_FORMAT  = process.env.INPUT_AUDIO_FORMAT  || "pcm16";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
  process.exit(1);
}

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/voice" });

wss.on("connection", (client) => {
  console.log("browser connected");

  // 1) Connect to OpenAI Realtime WS (Server ↔ OpenAI)
  const upstream = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // 2) Queue anything we need to send until upstream is OPEN
  const OPEN = WebSocket.OPEN;
  const pending: Array<string | Buffer> = [];

  function sendUpstream(payload: string | Buffer) {
    if (upstream.readyState === OPEN) {
      try {
        upstream.send(payload);
      } catch (err) {
        console.error("upstream send error", err);
      }
    } else {
      pending.push(payload);
    }
  }

  upstream.on("open", () => {
    console.log("upstream open (OpenAI)");

    // Configure the session immediately (force pcm16)
    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format: INPUT_AUDIO_FORMAT,
        output_audio_format: OUTPUT_AUDIO_FORMAT,
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 400,
          create_response: true,
          interrupt_response: true,
        },
      },
    };
    upstream.send(JSON.stringify(sessionUpdate));

    // Flush anything received from the browser while connecting
    while (pending.length) {
      const item = pending.shift()!;
      try {
        upstream.send(item);
      } catch (e) {
        console.error("flush send error", e);
      }
    }

    // Tell the browser we’re ready
    try {
      client.send(
        JSON.stringify({
          type: "ready",
          sessionId: `sess_${Math.random().toString(36).slice(2)}`,
        })
      );
    } catch {}
  });

  // Forward every message from OpenAI → Browser (text + audio chunks)
  upstream.on("message", (data, isBinary) => {
    try {
      client.send(data, { binary: isBinary });
    } catch (e) {
      console.error("client send error", e);
    }
  });

  upstream.on("error", (err) => {
    console.error("upstream error", err);
    try { client.close(1011, "upstream error"); } catch {}
  });

  upstream.on("close", (code, reason) => {
    console.log("upstream closed", code, reason.toString());
    try { client.close(code === 1000 ? 1000 : 1011, "upstream closed"); } catch {}
  });

  // Browser → Server messages (binary = mic audio, text = control JSON)
  client.on("message", (data, isBinary) => {
    if (isBinary) {
      // Wrap raw PCM16 bytes into OpenAI "append" event (base64)
      const b64 = Buffer.from(data as Buffer).toString("base64");
      sendUpstream(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      return;
    }

    // JSON control messages
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg?.type === "interrupt") {
      // Cancel the currently speaking response
      sendUpstream(JSON.stringify({ type: "response.cancel" }));
      return;
    }

    if (msg?.type === "response.create") {
      // Enforce pcm16 on replies even if the client forgets
      msg.response = msg.response || {};
      msg.response.output_audio_format = OUTPUT_AUDIO_FORMAT;
      sendUpstream(JSON.stringify(msg));
      return;
    }

    if (msg?.type === "session.update") {
      // Keep formats safe (pcm16)
      const safe = {
        type: "session.update",
        session: {
          ...msg.session,
          input_audio_format: INPUT_AUDIO_FORMAT,
          output_audio_format: OUTPUT_AUDIO_FORMAT,
        },
      };
      sendUpstream(JSON.stringify(safe));
      return;
    }

    // Pass through any other events as-is
    sendUpstream(JSON.stringify(msg));
  });

  client.on("close", () => {
    try { upstream.close(1000, "client left"); } catch {}
  });

  client.on("error", (err) => {
    console.error("browser ws error", err);
    try { upstream.close(1011, "client error"); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`voice backend listening on :${PORT}`);
  console.log("Audio formats:", { INPUT_AUDIO_FORMAT, OUTPUT_AUDIO_FORMAT });
});
