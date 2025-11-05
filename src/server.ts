import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import fetch from "node-fetch";
import { v4 as uuid } from "uuid";
import { gmailRead, gmailSearch, gmailSend } from "./gmail.js";

// -------------------------
// config / constants
// -------------------------
const PORT = Number(process.env.PORT || 10000);

// Deepgram STT
const DG_API_KEY = process.env.DEEPGRAM_API_KEY!;
const DG_STT_MODEL = process.env.DEEPGRAM_STT_MODEL || "nova-2";
const DG_STT_SR = Number(process.env.DEEPGRAM_STT_SAMPLE_RATE || 16000);

// Deepgram TTS
const DG_TTS_VOICE = process.env.DEEPGRAM_TTS_VOICE || "aura-asteria";
const DG_TTS_SR = Number(process.env.DEEPGRAM_TTS_SAMPLE_RATE || 16000);

// Mistral
const MISTRAL_KEY = process.env.MISTRAL_API_KEY!;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";
const SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT || "You are a concise, helpful voice assistant.";

// Minimal validation
for (const [name, v] of Object.entries({
  DEEPGRAM_API_KEY: DG_API_KEY,
  MISTRAL_API_KEY: MISTRAL_KEY,
})) {
  if (!v) throw new Error(`Missing env: ${name}`);
}

// -------------------------
// express
// -------------------------
const app = express();
app.use(cors());
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

// -------------------------
// WebSocket server
// -------------------------
const server = app.listen(PORT, () => {
  console.log(`voice backend listening on :${PORT}`);
});
const wss = new WebSocketServer({ server, path: "/ws/voice" });

// A very small “protocol” we keep compatible with your frontend:
// - send {type:"ready", sessionId}
// - accept binary PCM16 frames from browser mic
// - accept JSON control messages: session.update, response.create, interrupt
// - send out TTS audio as {type:"response.audio.delta", delta: base64PCM16}
// - send final markers & transcripts similar to OpenAI Realtime

wss.on("connection", (ws: WebSocket) => {
  const sessionId = `sess_${uuid().slice(0, 10)}`;

  // Per-connection state
  const state = {
    sttWs: null as WebSocket | null,
    ttsWs: null as WebSocket | null,
    speaking: false,
    closed: false,
    // last “final” transcript to feed the LLM
    bufferTranscript: "",
    // simple conversation memory (last few turns)
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
    ] as Array<{role: "system"|"user"|"assistant"|"tool", content: string; name?: string}>
  };

  // Send ready
  sendJson(ws, { type: "ready", sessionId });

  // Start STT pipe to Deepgram once we receive the first audio or session.update
  function ensureStt() {
    if (state.sttWs) return;
    const url = `wss://api.deepgram.com/v1/listen?model=${encodeURIComponent(DG_STT_MODEL)}&encoding=linear16&sample_rate=${DG_STT_SR}&punctuate=true&smart_format=true&vad_turnoff=true&endpointing=true&multichannel=false`;
    const dg = new WebSocket(url, { headers: { Authorization: `Token ${DG_API_KEY}` } });
    state.sttWs = dg;

    dg.on("open", () => {
      // nothing: config came via query
    });

    dg.on("message", async (data: Buffer) => {
      // Deepgram sends JSON events for transcripts
      try {
        const msg = JSON.parse(data.toString());
        // Look for "is_final" transcripts
        const alt = msg?.channel?.alternatives?.[0];
        const transcript: string | undefined = alt?.transcript;
        const isFinal: boolean = msg?.is_final === true || msg?.type === "UtteranceEnd";
        if (transcript && transcript.trim()) {
          // Live partials → could send to UI as captions if you want
          sendJson(ws, { type: "response.audio_transcript.delta", transcript });
        }
        if (transcript && isFinal) {
          state.bufferTranscript = transcript.trim();
          // Run agent turn
          await handleUserTurn(state.bufferTranscript);
          state.bufferTranscript = "";
        }
      } catch {
        // ignore non-JSON (DG may send pings)
      }
    });

    dg.on("close", () => { state.sttWs = null; });
    dg.on("error", () => { /* swallow */ });
  }

  // Convert LLM reply to TTS (Deepgram WebSocket TTS) and stream to browser
  async function speak(text: string) {
    if (state.ttsWs) {
      try { state.ttsWs.close(); } catch {}
      state.ttsWs = null;
    }
    state.speaking = true;

    // See Deepgram TTS WebSocket docs (Aura WS streaming). We’ll send config and stream the text.
    // Returns BINARY audio frames we forward as base64 PCM16 to the frontend.
    // Docs: Realtime TTS over WS & examples. :contentReference[oaicite:4]{index=4}
    const url = `wss://api.deepgram.com/v1/speak?model=${encodeURIComponent(DG_TTS_VOICE)}&encoding=linear16&sample_rate=${DG_TTS_SR}`;
    const dgTts = new WebSocket(url, { headers: { Authorization: `Token ${DG_API_KEY}` } });
    state.ttsWs = dgTts;

    dgTts.on("open", () => {
      // Send the text chunk; you can also chunk long text for lower latency. :contentReference[oaicite:5]{index=5}
      dgTts.send(JSON.stringify({ type: "text", text }));
      // Signal done so DG can flush audio
      dgTts.send(JSON.stringify({ type: "flush" }));
    });

    dgTts.on("message", (data: Buffer, isBinary: boolean) => {
      // Deepgram sends both JSON and binary; forward only binary audio frames
      if (isBinary) {
        const b64 = data.toString("base64");
        sendJson(ws, { type: "response.audio.delta", delta: b64 });
      } else {
        // JSON status/progress; ignore
      }
    });

    dgTts.on("close", () => {
      state.speaking = false;
      sendJson(ws, { type: "response.audio.done" });
    });

    dgTts.on("error", () => {
      state.speaking = false;
      sendJson(ws, { type: "response.audio.done" });
    });
  }

  async function handleUserTurn(userText: string) {
    if (!userText) return;
    state.messages.push({ role: "user", content: userText });

    const { answer, toolEvents } = await callMistralWithTools(state.messages);

    // If the model asked to use tools, we already executed them in callMistralWithTools.
    // Now speak the final answer.
    state.messages.push({ role: "assistant", content: answer });
    sendJson(ws, { type: "response.audio_transcript.delta", transcript: answer });
    await speak(answer);

    // Finish markers for the UI (keeps it familiar)
    sendJson(ws, { type: "response.audio_transcript.done" });
    sendJson(ws, { type: "response.done" });
  }

  // Minimal tool loop with Mistral function calling
  async function callMistralWithTools(history: Array<{role:string; content:string; name?: string}>) {
    // Prepare tool specs (JSON schema) for Mistral :contentReference[oaicite:6]{index=6}
    const tools = [
      {
        type: "function",
        function: {
          name: "gmail_search",
          description: "Search Gmail with a query (e.g., from:, subject:, newer_than:7d). Returns up to 5 message ids with headers.",
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
          parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
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

    // Mistral messages are OpenAI-like
    const mistralMessages = history.map(m => {
      if (m.role === "tool") {
        return { role: "tool", name: m.name, content: m.content };
      }
      return { role: m.role as "system"|"user"|"assistant", content: m.content };
    });

    // 1st call: let the model decide to use a tool or answer
    const first = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MISTRAL_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: mistralMessages,
        tools,
        tool_choice: "auto",
        temperature: 0.6,
        stream: false
      })
    }).then(r => r.json());

    // If there are tool calls, execute them and do a second call with tool results
    const toolCalls = first?.choices?.[0]?.message?.tool_calls || [];
    const toolEvents: string[] = [];

    if (Array.isArray(toolCalls) && toolCalls.length) {
      for (const call of toolCalls) {
        const toolName = call.function?.name;
        const args = safeJson(call.function?.arguments || "{}");
        let result: any = { ok: false, note: "no result" };
        try {
          if (toolName === "gmail_search") result = await gmailSearch(args.query, args.maxResults);
          else if (toolName === "gmail_read") result = await gmailRead(args.id);
          else if (toolName === "gmail_send") result = await gmailSend(args.to, args.subject, args.body);
          toolEvents.push(`${toolName} ✓`);
        } catch (e: any) {
          result = { ok: false, error: String(e?.message || e) };
          toolEvents.push(`${toolName} ✗`);
        }
        // push tool result back to conversation
        state.messages.push({ role: "tool", name: toolName, content: JSON.stringify(result) });
      }

      const second = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${MISTRAL_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          messages: state.messages.map(m => {
            if (m.role === "tool") return { role: "tool", name: m.name, content: m.content };
            return { role: m.role, content: m.content };
          }),
          temperature: 0.6,
          stream: false
        })
      }).then(r => r.json());

      const finalAnswer = second?.choices?.[0]?.message?.content || "Done.";
      return { answer: String(finalAnswer), toolEvents };
    } else {
      // No tool use, just answer
      const finalAnswer = first?.choices?.[0]?.message?.content || "Okay.";
      return { answer: String(finalAnswer), toolEvents };
    }
  }

  // Incoming messages from the browser
  ws.on("message", async (data: Buffer, isBinary: boolean) => {
    if (state.closed) return;

    if (isBinary) {
      ensureStt();
      // forward raw PCM16 to Deepgram STT
      state.sttWs?.readyState === WebSocket.OPEN && state.sttWs.send(data);
      return;
    }

    // JSON control
    let msg: any = null;
    try { msg = JSON.parse(data.toString()); } catch { /* ignore */ }

    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "session.update": {
        // Confirm back (format is already PCM16)
        sendJson(ws, {
          type: "session.updated",
          session: {
            instructions: SYSTEM_PROMPT,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16"
          }
        });
        return;
      }
      case "interrupt": {
        // Stop any speaking
        if (state.ttsWs && state.ttsWs.readyState === WebSocket.OPEN) {
          try { state.ttsWs.close(); } catch {}
          state.ttsWs = null;
          state.speaking = false;
        }
        return;
      }
      case "response.create": {
        // Test Hello path: just speak the provided text
        const text = msg?.response?.instructions || "Hello!";
        sendJson(ws, { type: "response.created" });
        await speak(String(text));
        return;
      }
      default:
        return;
    }
  });

  ws.on("close", () => {
    state.closed = true;
    try { state.sttWs?.close(); } catch {}
    try { state.ttsWs?.close(); } catch {}
  });
});

function sendJson(ws: WebSocket, obj: unknown) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return {}; }
}
