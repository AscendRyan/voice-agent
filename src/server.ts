import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import { v4 as uuid } from "uuid";
import { gmailRead, gmailSearch, gmailSend } from "./gmail.js";

/* ================================
   Config
==================================*/
const PORT = Number(process.env.PORT || 10000);

// Deepgram STT & TTS
const DG_API_KEY = mustEnv("DEEPGRAM_API_KEY");
const DG_STT_MODEL = process.env.DEEPGRAM_STT_MODEL || "nova-2";
const DG_STT_SR = toNum(process.env.DEEPGRAM_STT_SAMPLE_RATE, 16000);

const DG_TTS_VOICE = process.env.DG_TTS_VOICE || "aura-asteria-en"; // MUST include -en (or a valid Aura-2 voice)
const DG_TTS_SR = toNum(process.env.DG_TTS_SAMPLE_RATE, 16000);
const DG_TTS_ENCODING = process.env.DG_TTS_ENCODING || "linear16";  // linear16 means PCM16

// Mistral LLM (tool calling)
const MISTRAL_KEY = mustEnv("MISTRAL_API_KEY");
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";
const SYSTEM_PROMPT =
  process.env.AGENT_SYSTEM_PROMPT ||
  "You are a concise, helpful voice assistant. Prefer short answers unless asked for detail. If tools can help, call them.";

// If STT never flags a final, upgrade latest partial to final after this silence
const PARTIAL_TIMEOUT_MS = toNum(process.env.PARTIAL_TIMEOUT_MS, 900);

// Optional: keep client connections alive
const PING_MS = toNum(process.env.WS_PING_MS, 25000);

/* ================================
   Types (Mistral)
==================================*/
type MistralToolCall = {
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
};

type MistralMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: MistralToolCall[] }
  | { role: "tool"; name?: string; content: string };

type MistralChoice = {
  index?: number;
  message?: {
    role?: "assistant" | "user" | "system" | "tool";
    content?: string;
    tool_calls?: MistralToolCall[];
  };
  finish_reason?: string;
};

type MistralChatResponse = {
  id?: string;
  object?: string;
  model?: string;
  choices?: MistralChoice[];
  usage?: unknown;
};

/* ================================
   Express + WS bootstrap
==================================*/
const app = express();
app.use(cors());
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

const server = app.listen(PORT, () => {
  console.log(`voice backend listening on :${PORT}`);
});

const wss = new WebSocketServer({ server, path: "/ws/voice" });

wss.on("connection", (ws: WebSocket, req) => {
  const sessionId = `sess_${uuid().slice(0, 10)}`;
  console.log(`[WS] client connected ${sessionId} from ${req.socket.remoteAddress}`);

  // Track per-connection state
  const state = {
    sttWs: null as WebSocket | null,
    ttsWs: null as WebSocket | null,
    closed: false,
    lastPartial: "" as string,
    partialTimer: null as NodeJS.Timeout | null,
    speaking: false,
    pingTimer: null as NodeJS.Timeout | null,
    // dialog memory for the LLM
    messages: [{ role: "system", content: SYSTEM_PROMPT }] as MistralMessage[],
  };

  // Keep-alive ping (helps proxies keep WS open)
  if (PING_MS > 0) {
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch {}
      }
    }, PING_MS);
  }

  // Greet the client
  sendJson(ws, { type: "ready", sessionId });

  /* =============== STT (Deepgram Realtime) =============== */
  function ensureStt() {
    if (state.sttWs) return;

    const url =
      `wss://api.deepgram.com/v1/listen` +
      `?model=${encodeURIComponent(DG_STT_MODEL)}` +
      `&encoding=linear16` + // PCM16 uplink from browser
      `&sample_rate=${DG_STT_SR}` +
      `&punctuate=true&smart_format=true` +
      `&vad_turnoff=true&endpointing=true&vad_events=true` +
      `&multichannel=false`;

    console.log(`[STT] opening ${url}`);
    const dg = new WebSocket(url, {
      headers: { Authorization: `Token ${DG_API_KEY}` },
    });
    state.sttWs = dg;

    dg.on("open", () => {
      console.log("[STT] open");
    });

    dg.on("message", async (data: Buffer) => {
      // Deepgram realtime sends JSON for results/metadata; audio is inbound only.
      let msg: any = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        // non-JSON control frames can be ignored
        return;
      }

      // Useful to see in Render logs (but don't spam on every partial)
      if (msg?.type === "Open") {
        console.log("[STT] session opened");
      } else if (msg?.type === "Warning") {
        console.warn("[STT] warning", msg);
      }

      const alt = msg?.channel?.alternatives?.[0];
      const transcript: string | undefined = alt?.transcript;
      const isFinal: boolean =
        msg?.is_final === true ||
        msg?.type === "UtteranceEnd" ||
        (msg?.type === "Results" && msg?.speech_final === true);

      if (transcript && transcript.trim()) {
        state.lastPartial = transcript.trim();

        // forward partial to browser (live caption)
        sendJson(ws, { type: "stt.partial", transcript: state.lastPartial });

        // reset finalize timer
        schedulePartialFinalize();
      }

      if (isFinal) {
        finalizeNow("stt-final");
      }
    });

    dg.on("close", (code, reason) => {
      console.log(`[STT] close code=${code} reason=${reason.toString() || "(none)"}`);
      state.sttWs = null;
    });

    dg.on("error", (err) => {
      console.error("[STT] error", err?.toString?.() || err);
    });
  }

  function schedulePartialFinalize() {
    if (state.partialTimer) clearTimeout(state.partialTimer);
    state.partialTimer = setTimeout(() => finalizeNow("silence-timeout"), PARTIAL_TIMEOUT_MS);
  }

  async function finalizeNow(trigger: "silence-timeout" | "stt-final") {
    if (state.partialTimer) {
      clearTimeout(state.partialTimer);
      state.partialTimer = null;
    }
    const text = state.lastPartial.trim();
    if (!text) return;

    console.log(`[TURN] finalized (${trigger}) -> "${text}"`);
    state.lastPartial = "";

    // share the final transcript to the UI
    sendJson(ws, { type: "stt.final", transcript: text });
    await handleUserTurn(text);
  }

  /* =============== TTS (Deepgram Speak over WS) =============== */
  async function ttsSpeakAndStream(text: string) {
    // stop any previous TTS
    if (state.ttsWs) {
      try { state.ttsWs.close(); } catch {}
      state.ttsWs = null;
    }
    state.speaking = true;

    const voice = DG_TTS_VOICE; // e.g., "aura-asteria-en" or "aura-2-thalia-en"
    const encoding = DG_TTS_ENCODING; // "linear16"
    const sampleRate = DG_TTS_SR;

    const speakUrl =
      `wss://api.deepgram.com/v1/speak` +
      `?model=${encodeURIComponent(voice)}` +
      `&encoding=${encodeURIComponent(encoding)}` +
      `&sample_rate=${encodeURIComponent(String(sampleRate))}`;

    console.log(`[TTS] open ${voice} sr=${sampleRate}`);
    const dg = new WebSocket(speakUrl, {
      headers: { Authorization: `Token ${DG_API_KEY}` },
    });
    state.ttsWs = dg;

    // Tell the browser a new audio content part is starting (for some UIs)
    sendJson(ws, {
      type: "response.content_part.added",
      item_id: `tts_${Date.now()}`,
      response_id: `resp_${Date.now()}`,
      output_index: 0,
      content_index: 0,
      part: { type: "audio" },
    });

    dg.on("open", () => {
      console.log("[TTS] websocket opened -> Speak + Flush");
      try {
        dg.send(JSON.stringify({ type: "Speak", text }));
        dg.send(JSON.stringify({ type: "Flush" }));
      } catch (err) {
        console.error("[TTS] send error", err);
      }
    });

    dg.on("message", (data) => {
      // Deepgram Speak sends binary PCM16 audio frames + JSON metadata
      if (Buffer.isBuffer(data)) {
        const b64 = data.toString("base64");
        // forward to browser as PCM16 base64 chunks
        sendJson(ws, {
          type: "response.audio.delta",
          response_id: `resp_${sessionId}`,
          item_id: `item_${sessionId}`,
          output_index: 0,
          content_index: 0,
          delta: b64,
        });
      } else {
        try {
          const msg = JSON.parse(String(data));
          if (msg?.type === "Metadata") {
            console.log(`[TTS] metadata model=${msg.model_name} ver=${msg.model_version}`);
          } else if (msg?.type === "Warning") {
            console.warn("[TTS] warning", msg);
          } else if (msg?.type === "Flushed") {
            // End of utterance
            sendJson(ws, {
              type: "response.audio.done",
              response_id: `resp_${sessionId}`,
              item_id: `item_${sessionId}`,
              output_index: 0,
              content_index: 0,
            });
            try { dg.close(); } catch {}
          }
        } catch {
          // Some providers send plain text lines too
          console.log("[TTS] text frame:", String(data));
        }
      }
    });

    dg.on("close", (code, reason) => {
      console.log("[TTS] closed", code, reason.toString?.() || "");
      state.speaking = false;
      // Ensure the browser doesn't wait forever
      sendJson(ws, {
        type: "response.audio.done",
        response_id: `resp_${sessionId}`,
        item_id: `item_${sessionId}`,
        output_index: 0,
        content_index: 0,
      });
    });

    dg.on("error", (err) => {
      console.error("[TTS] error", err?.toString?.() || err);
      state.speaking = false;
      sendJson(ws, {
        type: "response.audio.done",
        response_id: `resp_${sessionId}`,
        item_id: `item_${sessionId}`,
        output_index: 0,
        content_index: 0,
      });
    });
  }

  /* =============== LLM + Tools (Mistral) =============== */
  async function handleUserTurn(userText: string) {
    if (!userText) return;

    state.messages.push({ role: "user", content: userText });
    console.log(`[LLM] user: ${userText}`);

    try {
      const { answer } = await callMistralWithTools(state.messages);

      const final = String(answer || "Okay.");
      console.log(`[LLM] assistant: ${final}`);

      state.messages.push({ role: "assistant", content: final });

      // Send captions to UI (optional; nice for "live transcript" rows)
      sendJson(ws, { type: "response.audio_transcript.delta", transcript: final });

      // Speak it
      await ttsSpeakAndStream(final);

      sendJson(ws, { type: "response.audio_transcript.done" });
      sendJson(ws, { type: "response.done" });
    } catch (e: any) {
      console.error("[LLM] error", e?.message || e);
      const fallback = "Sorry — I hit an error.";
      await ttsSpeakAndStream(fallback);
    }
  }

  async function callMistralWithTools(history: MistralMessage[]): Promise<{ answer: string }> {
    const tools = [
      {
        type: "function",
        function: {
          name: "gmail_search",
          description:
            "Search Gmail with a query (e.g., from:, subject:, newer_than:7d). Returns up to 5 message ids with headers.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Gmail search query" },
              maxResults: { type: "integer", minimum: 1, maximum: 20, default: 5 },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "gmail_read",
          description: "Read a Gmail message by id; returns headers and plain text body.",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "gmail_send",
          description: "Send an email via Gmail.",
          parameters: {
            type: "object",
            properties: {
              to: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" },
            },
            required: ["to", "subject", "body"],
          },
        },
      },
    ];

    const mistralMessages = history.map((m) =>
      m.role === "tool"
        ? { role: "tool" as const, name: m.name, content: m.content }
        : { role: m.role as "system" | "user" | "assistant", content: m.content }
    );

    // First pass: allow tool calls
    const first: MistralChatResponse = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MISTRAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: mistralMessages,
        tools,
        tool_choice: "auto",
        temperature: 0.6,
        stream: false,
      }),
    }).then((r) => r.json() as Promise<MistralChatResponse>);

    const firstChoice = first?.choices?.[0];
    const calls: MistralToolCall[] = Array.isArray(firstChoice?.message?.tool_calls)
      ? (firstChoice!.message!.tool_calls as MistralToolCall[])
      : [];

    if (calls.length) {
      // Run tools
      for (const call of calls) {
        const toolName = call.function?.name;
        const args = safeJson(call.function?.arguments || "{}");
        let result: any = { ok: false, note: "no result" };

        try {
          if (toolName === "gmail_search") {
            result = await gmailSearch(String(args.query || ""), toNum(args.maxResults, 5));
          } else if (toolName === "gmail_read") {
            result = await gmailRead(String(args.id || ""));
          } else if (toolName === "gmail_send") {
            result = await gmailSend(
              String(args.to || ""),
              String(args.subject || ""),
              String(args.body || "")
            );
          } else {
            result = { ok: false, error: `Unknown tool ${toolName}` };
          }
        } catch (e: any) {
          result = { ok: false, error: String(e?.message || e) };
        }

        // Return tool result back to the LLM
        state.messages.push({
          role: "tool",
          name: toolName,
          content: JSON.stringify(result),
        });
      }

      // Second pass: produce final message
      const second: MistralChatResponse = await fetch(
        "https://api.mistral.ai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${MISTRAL_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MISTRAL_MODEL,
            messages: state.messages.map((m) =>
              m.role === "tool"
                ? { role: "tool", name: m.name, content: m.content }
                : { role: m.role, content: m.content }
            ),
            temperature: 0.6,
            stream: false,
          }),
        }
      ).then((r) => r.json() as Promise<MistralChatResponse>);

      const finalAnswer = second?.choices?.[0]?.message?.content || "Done.";
      return { answer: finalAnswer };
    }

    // No tools used — return the assistant message as-is
    const finalAnswer = firstChoice?.message?.content || "Okay.";
    return { answer: finalAnswer };
  }

  /* =============== WS from browser =============== */
  ws.on("message", async (data: Buffer, isBinary: boolean) => {
    if (state.closed) return;

    if (isBinary) {
      // Incoming mic frames (PCM16). Ensure STT and forward.
      ensureStt();
      if (state.sttWs?.readyState === WebSocket.OPEN) {
        state.sttWs.send(data);
      }
      return;
    }

    // Control messages
    let msg: any = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "session.update": {
        // Inform the client of audio formats we expect
        sendJson(ws, {
          type: "session.updated",
          session: {
            instructions: SYSTEM_PROMPT,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
          },
        });
        return;
      }

      case "interrupt": {
        console.log("[INTERRUPT] stop speaking if any");
        if (state.ttsWs && state.ttsWs.readyState === WebSocket.OPEN) {
          try { state.ttsWs.close(); } catch {}
        }
        state.ttsWs = null;
        state.speaking = false;
        return;
      }

      case "response.create": {
        // Dev/Test button from browser to force TTS
        const text = msg?.response?.instructions || "Hello!";
        console.log(`[TEST] speak: ${text}`);
        sendJson(ws, { type: "response.created" });
        await ttsSpeakAndStream(String(text));
        return;
      }

      default:
        return;
    }
  });

  ws.on("close", () => {
    console.log(`[WS] client closed ${sessionId}`);
    state.closed = true;
    try { state.sttWs?.close(); } catch {}
    try { state.ttsWs?.close(); } catch {}
    if (state.partialTimer) clearTimeout(state.partialTimer);
    if (state.pingTimer) clearTimeout(state.pingTimer);
  });
});

/* ================================
   Helpers
==================================*/
function sendJson(ws: WebSocket, obj: unknown) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch {}
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function toNum(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
