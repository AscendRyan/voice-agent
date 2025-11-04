// src/server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import {
  getAuthUrl,
  handleOAuthCallback,
  hasRefreshToken,
  gmailSearch,
  gmailRead
} from "./google.js";

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

// ===== Basic HTTP app (health + OAuth) =====
const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("voice backend ok"));
app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    gmail_connected: hasRefreshToken(),
    model: process.env.REALTIME_MODEL || "gpt-realtime",
    tools_enabled: (process.env.ENABLE_TOOLS || "true") === "true"
  });
});

// Step 1: start Google OAuth (click this in the browser)
app.get("/auth/google", (_req, res) => {
  try {
    const url = getAuthUrl();
    res.redirect(url);
  } catch (e: any) {
    res.status(500).send(`OAuth not configured. ${e?.message || e}`);
  }
});

// Step 2: Google redirects here with ?code=...
app.get("/oauth2/callback", async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) return res.status(400).send("Missing ?code");
  try {
    const { refreshToken } = await handleOAuthCallback(code);
    const html = `
      <h2>Gmail connected!</h2>
      ${refreshToken ? `<p><b>Refresh token:</b> <code>${refreshToken}</code></p>` : "<p>(Refresh token already set.)</p>"}
      <p>Next step:</p>
      <ol>
        <li>In Render &rarr; your service &rarr; <b>Environment</b>, add <code>GMAIL_REFRESH_TOKEN</code> = the value above.</li>
        <li>Save, then <b>Deploy</b> (so it persists across restarts).</li>
      </ol>
      <p>Now the assistant can use Gmail tools.</p>
    `;
    res.send(html);
  } catch (e: any) {
    res.status(500).send(`OAuth exchange failed: ${e?.message || e}`);
  }
});

const server = http.createServer(app);

// ===== WebSocket bridge for /ws/voice =====
const wss = new WebSocketServer({ server, path: "/ws/voice" });

type PendingCall = { name?: string; args: string };
const TOOL_DEFS =
  (process.env.ENABLE_TOOLS || "true") === "true"
    ? [
        {
          type: "function",
          name: "gmail_search",
          description:
            "Search the user's Gmail. Return up to maxResults messages with id, from, subject, date, snippet. Use Gmail search syntax like `in:inbox newer_than:7d`.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Gmail search query" },
              maxResults: {
                type: "integer",
                minimum: 1,
                maximum: 10,
                default: 5
              }
            },
            required: ["query"]
          }
        },
        {
          type: "function",
          name: "gmail_read",
          description:
            "Read a Gmail message by id (from gmail_search). Return subject, from, date, snippet, and body_text (plain text only).",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "Gmail message id" }
            },
            required: ["id"]
          }
        }
      ]
    : [];

function sessionInstructions(): string {
  const base =
    process.env.DEFAULT_INSTRUCTIONS ||
    "You are a concise, helpful voice assistant. Speak in short UK English sentences. If a tool is useful, call it.";
  const toolHint = hasRefreshToken()
    ? "You can call gmail_search and gmail_read to help with emails."
    : "If asked to use Gmail, say Gmail is not connected and ask the user to link it.";
  return `${base} ${toolHint}`;
}

function connectToOpenAI(): WebSocket {
  const model = process.env.REALTIME_MODEL || "gpt-realtime";
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });
  return ws;
}

wss.on("connection", (client) => {
  // Connect to OpenAI Realtime as soon as a browser connects to us.
  const openai = connectToOpenAI();

  // Buffer client messages until OpenAI socket is open
  const clientQueue: Array<Buffer | string> = [];
  let openaiReady = false;

  // Track function calls
  const pending: Record<string, PendingCall> = {};

  function sendToOpenAI(obj: any) {
    const raw = JSON.stringify(obj);
    if (openaiReady) openai.send(raw);
    else clientQueue.push(raw);
  }

  function forwardToClient(obj: any) {
    try {
      client.send(JSON.stringify(obj));
    } catch {}
  }

  openai.on("open", () => {
    openaiReady = true;

    // Configure the Realtime session
    sendToOpenAI({
      type: "session.update",
      session: {
        instructions: sessionInstructions(),
        voice: process.env.REALTIME_VOICE || "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: Number(process.env.TURN_SILENCE_MS || 500),
          create_response: true,
          interrupt_response: true
        },
        temperature: Number(process.env.SESSION_TEMPERATURE || 0.8),
        tools: TOOL_DEFS,
        tool_choice: "auto",
        max_response_output_tokens: "inf"
      }
    });

    // flush anything client sent while we were connecting
    for (const item of clientQueue) openai.send(item);
    clientQueue.length = 0;
  });

  // ===== Browser -> Backend (binary audio or JSON control) =====
  client.on("message", (data: Buffer, isBinary) => {
    if (isBinary) {
      // raw PCM16 -> forward straight through
      if (openaiReady) openai.send(data);
      else clientQueue.push(data);
      return;
    }

    // JSON control messages from the frontend
    let msg: any;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    // Interrupts from frontend map to response.cancel
    if (msg?.type === "interrupt") {
      sendToOpenAI({ type: "response.cancel" });
      return;
    }

    // Pass-through any other client events (e.g. response.create test)
    sendToOpenAI(msg);
  });

  // ===== OpenAI -> Backend =====
  openai.on("message", async (chunk) => {
    let evt: any;
    try {
      evt = JSON.parse(chunk.toString("utf8"));
    } catch {
      // Some server frames can be binary; forward to client as-is
      try {
        client.send(chunk);
      } catch {}
      return;
    }

    // ---- Tool calling handling (server side) ----
    // 1) Model declares a function call
    if (evt?.type === "response.function_call.created") {
      pending[evt.call_id] = { name: evt.name, args: "" };
      return;
    }

    // 2) Arguments stream in
    if (evt?.type === "response.function_call_arguments.delta") {
      const p = pending[evt.call_id] || { args: "" };
      p.args += evt.delta || "";
      pending[evt.call_id] = p;
      return;
    }

    // 3) Arguments finished -> execute tool
    if (evt?.type === "response.function_call_arguments.done") {
      const p = pending[evt.call_id];
      let args: any = {};
      try {
        args = p?.args ? JSON.parse(p.args) : {};
      } catch {
        args = {};
      }

      let output: any = { ok: false, error: "Unknown tool" };
      try {
        if (p?.name === "gmail_search") {
          output = await gmailSearch({ query: String(args.query || ""), maxResults: args.maxResults });
        } else if (p?.name === "gmail_read") {
          output = await gmailRead({ id: String(args.id || "") });
        } else {
          output = { ok: false, error: `Tool ${p?.name} not implemented.` };
        }
      } catch (e: any) {
        output = { ok: false, error: e?.message || String(e) };
      }

      // 4) Send function_call_output back to OpenAI
      sendToOpenAI({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: evt.call_id,
          output: JSON.stringify(output)
        }
      });

      // 5) Ask the model to continue, using the tool result
      sendToOpenAI({
        type: "response.create",
        response: {
          instructions:
            "Use the tool output to answer the user. If you looked at emails, summarise clearly and ask if they want to read any.",
          modalities: ["audio", "text"]
        }
      });

      return;
    }

    // For all other events (audio deltas, transcripts, ready, etc.) just forward to browser
    forwardToClient(evt);
  });

  // Propagate close/error both ways
  const safeClose = () => {
    try {
      if (openai.readyState === WebSocket.OPEN || openai.readyState === WebSocket.CONNECTING) {
        openai.close();
      }
    } catch {}
    try {
      if (client.readyState === WebSocket.OPEN) client.close();
    } catch {}
  };

  client.on("close", safeClose);
  client.on("error", safeClose);
  openai.on("close", () => {
    try {
      client.send(JSON.stringify({ type: "closed" }));
    } catch {}
    safeClose();
  });
  openai.on("error", safeClose);
});

server.listen(PORT, () => {
  console.log(`voice backend listening on :${PORT}`);
});
