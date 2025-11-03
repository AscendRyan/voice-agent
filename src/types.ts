import { z } from "zod";

// Individual message shapes
export const SessionInit = z.object({
  type: z.literal("session.init"),
  sessionId: z.string().optional(),
  instructions: z.string().optional(),
});

export const Interrupt = z.object({
  type: z.literal("interrupt"),
});

export const Commit = z.object({
  type: z.literal("commit"),
});

export const ResponseCreate = z.object({
  type: z.literal("response.create"),
  // Pass-through bag for OpenAI response.create options (optional)
  response: z.record(z.any()).optional(),
});

export const SessionUpdate = z.object({
  type: z.literal("session.update"),
  session: z.record(z.any()),
});

// Discriminated union the compiler can narrow on
export const ClientMessageSchema = z.union([
  SessionInit,
  Interrupt,
  Commit,
  ResponseCreate,
  SessionUpdate,
]);

export type ClientControlMessage = z.infer<typeof ClientMessageSchema>;

export type ServerInfo =
  | { type: "ready"; sessionId: string }
  | { type: "error"; message: string; details?: unknown };
