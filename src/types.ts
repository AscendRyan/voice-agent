export type ClientControlMessage =
  | { type: "session.init"; sessionId?: string; instructions?: string }
  | { type: "interrupt" }
  | { type: "commit" } // commit current mic buffer manually if using client VAD
  | {
      type: "response.create";
      response?: Record<string, unknown>; // pass-through to OpenAI
    }
  | { type: "session.update"; session: Record<string, unknown> };

export type ServerInfo =
  | { type: "ready"; sessionId: string }
  | { type: "error"; message: string; details?: unknown };

export type AnyClientMessage = ClientControlMessage;
