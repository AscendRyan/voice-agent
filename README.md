# Voice Backend (OpenAI Realtime Proxy)

## 1) Setup
cp .env.example .env
# fill OPENAI_API_KEY, MODEL, etc.

pnpm i   # or npm i / yarn

## 2) Run
pnpm dev
# -> ws at ws://localhost:8787/ws/voice

## 3) Frontend contract (Lovable)
- Connect WebSocket to `${VITE_VOICE_WS_URL}` (e.g., wss://your-domain/ws/voice)
- On open: send optional `{"type":"session.init","instructions":"<system message>"}`

### Mic streaming
- Record 16kHz mono PCM16 (or Opus) frames (~100–200ms)
- Send **binary** frames over the WebSocket *as they are recorded*
- (Server converts to base64 and forwards as `input_audio_buffer.append`)

### Auto-turns
- Server uses server VAD; the model will auto-commit and respond.
- To force a commit (client VAD): send `{"type":"commit"}` then optionally `{"type":"response.create"}`

### Interrupt (barge-in)
- When user starts speaking during AI playback, send `{"type":"interrupt"}`
- Stop local playback immediately.

### Playback
- Listen for JSON messages from the server.
- For frames with `type:"response.audio.delta"`, decode the base64 audio and append to a WebAudio Source.
- You may also see text events (e.g., `response.output_text.delta`).

### Environment
- Use `VITE_VOICE_WS_URL` or similar in Lovable config.

