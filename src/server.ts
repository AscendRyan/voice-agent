client.on("message", (data, isBinary) => {
  // BINARY: audio frames from the browser (PCM/Opus). We convert to base64
  // and forward as input_audio_buffer.append to OpenAI.
  if (isBinary) {
    const base64 = Buffer.from(data as Buffer).toString("base64");
    upstream.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64 }));
    return;
  }

  // TEXT: control messages in JSON
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

  const msg = result.data; // <-- now strongly typed & non-undefined

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
      // Stop any ongoing generation/audio
      upstream.send(JSON.stringify({ type: "response.cancel" }));
      break;
    }

    case "commit": {
      // If you ever disable server VAD, you can commit manually
      upstream.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      // Optionally kick off a response explicitly:
      // upstream.send(JSON.stringify({ type: "response.create" }));
      break;
    }

    case "response.create": {
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
      upstream.send(
        JSON.stringify({ type: "session.update", session: msg.session })
      );
      break;
    }

    default: {
      // Should be unreachable thanks to the discriminated union,
      // but keep a pass-through just in case you add new message types later.
      upstream.send(JSON.stringify(msg));
    }
  }
});
