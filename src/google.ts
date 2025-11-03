// src/google.ts
import fs from "fs";
import path from "path";
import express from "express";
import { google } from "googleapis";

const TOKENS_PATH = process.env.GOOGLE_TOKENS_PATH || path.join(process.cwd(), "tokens.json");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URL = process.env.GOOGLE_REDIRECT_URL || ""; // e.g. https://voice-agent-xxxx.onrender.com/auth/google/callback

// Minimal scopes for read/search. Add gmail.send later if needed.
const DEFAULT_SCOPES = (process.env.GMAIL_SCOPES ??
  "https://www.googleapis.com/auth/gmail.readonly").split(",");

function getOAuth2Client() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URL) {
    throw new Error("Missing Google OAuth env vars (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URL).");
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL);
}

export function installGoogleAuthRoutes(app: express.Express) {
  // Start OAuth
  app.get("/auth/google/start", (req, res) => {
    try {
      const oAuth2Client = getOAuth2Client();
      const url = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: DEFAULT_SCOPES,
      });
      res.redirect(url);
    } catch (e: any) {
      res.status(500).send(e?.message || "OAuth setup error");
    }
  });

  // OAuth callback
  app.get("/auth/google/callback", async (req, res) => {
    try {
      const code = String(req.query.code || "");
      const oAuth2Client = getOAuth2Client();
      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
      res.send("✅ Gmail connected. You can close this tab.");
    } catch (e: any) {
      res.status(500).send("OAuth error: " + (e?.message || e));
    }
  });

  // Status check
  app.get("/auth/google/status", async (_req, res) => {
    res.json({ connected: fs.existsSync(TOKENS_PATH) });
  });
}

// Returns an authenticated Gmail client, or throws if not connected.
export async function getGmail() {
  const oAuth2Client = getOAuth2Client();
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error("Gmail not connected yet. Visit /auth/google/start first.");
  }
  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  oAuth2Client.setCredentials(tokens);
  // auto-refresh token if needed
  oAuth2Client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2));
  });
  return google.gmail({ version: "v1", auth: oAuth2Client });
}

// Simple helper: search Gmail and return a few subjects/snippets.
export async function gmailSearch({ query = "is:unread", max = 5 }: { query?: string; max?: number }) {
  const gmail = await getGmail();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: Math.max(1, Math.min(max, 10)),
  });

  const messages = list.data.messages || [];
  const out: Array<{ id: string; subject: string; from: string; snippet: string }> = [];

  for (const m of messages) {
    if (!m.id) continue;
    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["Subject", "From"] });
    const headers = full.data.payload?.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
    const from = headers.find((h) => h.name === "From")?.value || "(unknown)";
    out.push({ id: m.id, subject, from, snippet: full.data.snippet || "" });
  }

  return { count: out.length, query, results: out };
}
