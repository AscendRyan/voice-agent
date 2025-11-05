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

// Deepgram STT (Realtime) and TTS (WS)
const DG_API_KEY = mustEnv("DEEPGRAM_API_KEY");
const DG_STT_MODEL = process.env.DEEPGRAM_STT_MODEL || "nova-2";
const DG_STT_SR = num(process.env.DEEPGRAM_STT_SAMPLE_RATE, 16000);
const DG_TTS_VOICE = process.env.DEEPGRAM_TTS_VOICE || "aura-asteria";
const DG_TTS_SR = num(process.env.DEEPGRAM_TTS_SAMPLE_RATE, 16000);

// Mistral LLM (function/tool calling)
const MISTRAL_KEY = mustEnv("MISTRAL_API_KEY");
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";
const SYSTEM_PROMPT =
  process.env.AGENT_SYSTEM_PROMPT ||
  "You are a concise, helpful voice assistant for natural phone-like conversations. Prefer short answers unless asked for detail. If tools can help, call them.";

// Partial → final timeout (if no STT 'final' arrives)
const PARTIAL_TIMEOUT_MS = num(process.env.PARTIAL_TIMEOUT_MS, 800);

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
   Express + WS
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

  const state = {
    sttWs: null as WebSocket | null,
    ttsWs: null as WebSocket | null,
    speaking: false,
    closed: false,
    // partial buffer
    latestPartial: "" as string,
    partialTimer: null as NodeJS.Timeout | null,
    // convo
    messages: [{ role: "system", content: SYSTEM_PROMPT }] as MistralMessage[],
  };

  sendJson(ws, { type: "ready", sessionId });

  function ensureStt() {
    if (state.sttWs) return;

    // Ask Deepgram to give us utterance end events; still handle silence fallback.
    const url =
      `wss://api.deepgram.com/v1/listen` +
      `?model=${encodeURIComponent(DG_STT_MODEL)}` +
      `&encoding=linear16` +
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
      // Deepgram sends JSON control + binary audio back for echo cancellation sometimes. We care about JSON transcripts.
      let msg: any = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Try to read transcript & final-ish markers
      const alt = msg?.channel?.alternatives?.[0];
      const transcript: string | undefined = alt?.transcript;
      const isFinal: boolean =
        msg?.is_final === true ||
        msg?.type === "UtteranceEnd" ||
        msg?.type === "Results" && msg?.speech_final === true;

      if (transcript && transcript.trim()) {
        state.latestPartial = transcript.trim();
        // forward partials to the browser (handy for a live caption)
        sendJson(ws, {
          type: "stt.partial",
          transcript: state.latestPartial,
        });
        schedulePartialFinalize();
      }

      if (isFinal) {
        finalizeNow("stt-final-flag");
      }
    });

    dg.on("close", (code, reason) => {
      console.log(`[STT] close code=${code} reason=${reason.toString() || "(none)"}`);
      state.sttWs = null;
    });

    dg.on("error", (err) => {
      console.log("[STT] error", err?.toString?.() || err);
    });
  }

  function schedulePartialFinalize() {
    if (state.partialTimer) clearTimeout(state.partialTimer);
    state.partialTimer = setTimeout(() => finalizeNow("silence-timeout"), PARTIAL_TIMEOUT_MS);
  }

  async function finalizeNow(trigger: "silence-timeout" | "stt-final-flag") {
    if (state.partialTimer) {
      clearTimeout(state.partialTimer);
      state.partialTimer = null;
    }
    const text = state.latestPartial.trim();
    if (!text) return;

    console.log(`[TURN] finalize (${trigger}) → "${text}"`);
    state.latestPartial = "";
    await handleUserTurn(text);
  }

  async function speak(text: string) {
    // stop previous TTS if any
    if (state.ttsWs) {
      try { state.ttsWs.close(); } catch {}
      state.ttsWs = null;
    }
    state.speaking = true;

    const url =
      `wss://api.deepgram.com/v1/speak` +
      `?model=${encodeURIComponent(DG_TTS_VOICE)}` +
      `&encoding=linear16` +
      `&sample_rate=${DG_TTS_SR}`;

    console.log(`[TTS] open ${DG_TTS_VOICE} sr=${DG_TTS_SR}`);
    const dgTts = new WebSocket(url, {
      headers: { Authorization: `Token ${DG_API_KEY}` },
    });
    state.ttsWs = dgTts;

    dgTts.on("open", () => {
      console.log("[TTS] start");
      dgTts.send(JSON.stringify({ type: "text", text }));
      dgTts.send(JSON.stringify({ type: "flush" }));
    });

    dgTts.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const b64 = data.toString("base64");
        sendJson(ws, { type: "response.audio.delta", delta: b64 });
      } else {
        // non-binary status messages can be ignored
      }
    });

    dgTts.on("close", () => {
      console.log("[TTS] done");
      state.speaking = false;
      sendJson(ws, { type: "response.audio.done" });
    });

    dgTts.on("error", (e) => {
      console.log("[TTS] error", e?.toString?.() || e);
      state.speaking = false;
      sendJson(ws, { type: "response.audio.done" });
    });
  }

  async function handleUserTurn(userText: string) {
    if (!userText) return;
    console.log(`[LLM] user: ${userText}`);
    state.messages.push({ role: "user", content: userText });

    try {
      const { answer } = await callMistralWithTools(state.messages);
      console.log(`[LLM] assistant: ${answer}`);
      state.messages.push({ role: "assistant", content: answer });

      // send transcript to client and speak it
      sendJson(ws, { type: "response.audio_transcript.delta", transcript: answer });
      await speak(answer);
      sendJson(ws, { type: "response.audio_transcript.done" });
      sendJson(ws, { type: "response.done" });
    } catch (e: any) {
      console.log("[LLM] error", e?.message || e);
      const fallback = "Sorry — I ran into an issue answering that.";
      await speak(fallback);
    }
  }

  async function callMistralWithTools(history: MistralMessage[]) {
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
              maxResults: { type: "integer", minimum: 1, maximum: 20, default: 5 }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "gmail_read",
          description: "Read a Gmail message by id; returns headers and plain text body.",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"]
          }
        }
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
              body: { type: "string" }
            },
            required: ["to", "subject", "body"]
          }
        }
      }
    ];

    const mistralMessages = history.map((m) => {
      if (m.role === "tool") return { role: "tool" as const, name: m.name, content: m.content };
      return { role: m.role as "system" | "user" | "assistant", content: m.content };
    });

    // First call: allow tool calls
    const first: MistralChatResponse = await fetch(
      "https://api.mistral.ai/v1/chat/completions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${MISTRAL_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: mistralMessages,
          tools,
          tool_choice: "auto",
          temperature: 0.6,
          stream: false
        })
      }
    ).then((r) => r.json() as Promise<MistralChatResponse>);

    const firstChoice = first.choices?.[0];
    const toolCalls: MistralToolCall[] = Array.isArray(firstChoice?.message?.tool_calls)
      ? firstChoice!.message!.tool_calls!
      : [];

    if (toolCalls.length) {
      for (const call of toolCalls) {
        const toolName = call.function?.name;
        const args = safeJson(call.function?.arguments || "{}");
        let result: any = { ok: false, note: "no result" };

        try {
          if (toolName === "gmail_search") {
            result = await gmailSearch(String(args.query || ""), num(args.maxResults, 5));
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

        state.messages.push({ role: "tool", name: toolName, content: JSON.stringify(result) });
      }

      // Second call: produce the final answer with tool results in context
      const second: MistralChatResponse = await fetch(
        "https://api.mistral.ai/v1/chat/completions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${MISTRAL_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MISTRAL_MODEL,
            messages: state.messages.map((m) =>
              m.role === "tool" ? { role: "tool", name: m.name, content: m.content } : { role: m.role, content: m.content }
            ),
            temperature: 0.6,
            stream: false
          })
        }
      ).then((r) => r.json() as Promise<MistralChatResponse>);

      const finalAnswer = second.choices?.[0]?.message?.content || "Done.";
      return { answer: String(finalAnswer) };
    } else {
      const finalAnswer = first.choices?.[0]?.message?.content || "Okay.";
      return { answer: String(finalAnswer) };
    }
  }

  ws.on("message", async (data: Buffer, isBinary: boolean) => {
    if (state.closed) return;

    if (isBinary) {
      // Incoming mic frames
      ensureStt();
      if (state.sttWs?.readyState === WebSocket.OPEN) {
        state.sttWs.send(data);
      }
      return;
    }

    // JSON control messages
    let msg: any = null;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "session.update": {
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
          state.ttsWs = null;
          state.speaking = false;
        }
        return;
      }

      case "response.create": {
        const text = msg?.response?.instructions || "Hello!";
        console.log(`[TEST] speak: ${text}`);
        sendJson(ws, { type: "response.created" });
        await speak(String(text));
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
  });
});

/* ================================
   Helpers
==================================*/
function sendJson(ws: WebSocket, obj: unknown) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return {}; }
}
function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
function num(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
