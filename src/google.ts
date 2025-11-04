// src/google.ts
import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

const SCOPES = (process.env.GMAIL_SCOPES || "https://www.googleapis.com/auth/gmail.readonly").split(",");

// In-memory fallback so you can test right after OAuth.
// For production, set GMAIL_REFRESH_TOKEN in Render.
let IN_MEMORY_REFRESH_TOKEN: string | null = null;

export function hasRefreshToken(): boolean {
  return Boolean(process.env.GMAIL_REFRESH_TOKEN || IN_MEMORY_REFRESH_TOKEN);
}

function makeOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "";

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI env vars.");
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN || IN_MEMORY_REFRESH_TOKEN;
  if (refreshToken) {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  }
  return oauth2Client;
}

export function getAuthUrl(): string {
  const oauth2Client = makeOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
}

export async function handleOAuthCallback(code: string): Promise<{ refreshToken?: string }> {
  const oauth2Client = makeOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  if (tokens.refresh_token) {
    IN_MEMORY_REFRESH_TOKEN = tokens.refresh_token;
    return { refreshToken: tokens.refresh_token };
  }
  return {};
}

function gmailClient(): gmail_v1.Gmail {
  const auth = makeOAuthClient();
  return google.gmail({ version: "v1", auth });
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  const h = headers?.find(h => (h.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || undefined;
}

function decodeBase64Url(data?: string): string {
  if (!data) return "";
  const buff = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buff.toString("utf8");
}

export async function gmailSearch(params: { query: string; maxResults?: number }) {
  if (!hasRefreshToken()) {
    return { ok: false, error: "Gmail is not connected. Visit /auth/google and complete sign-in." };
  }
  const gmail = gmailClient();
  const maxResults = Math.min(Math.max(params.maxResults || 5, 1), 10);
  const list = await gmail.users.messages.list({
    userId: "me",
    q: params.query,
    maxResults
  });

  const items: any[] = [];

  if (list.data.messages && list.data.messages.length) {
    for (const m of list.data.messages) {
      if (!m.id) continue;
      const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
      const headers = full.data.payload?.headers || [];
      items.push({
        id: m.id,
        snippet: full.data.snippet || "",
        from: headerValue(headers, "From") || "",
        subject: headerValue(headers, "Subject") || "",
        date: headerValue(headers, "Date") || ""
      });
    }
  }

  return { ok: true, results: items };
}

export async function gmailRead(params: { id: string }) {
  if (!hasRefreshToken()) {
    return { ok: false, error: "Gmail is not connected. Visit /auth/google and complete sign-in." };
  }
  const gmail = gmailClient();
  const msg = await gmail.users.messages.get({ userId: "me", id: params.id, format: "full" });

  const headers = msg.data.payload?.headers || [];
  let bodyText = "";

  // Try to find text/plain
  function walk(part?: gmail_v1.Schema$MessagePart) {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      bodyText += decodeBase64Url(part.body.data);
    }
    if (part.parts) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(msg.data.payload || undefined);

  return {
    ok: true,
    id: params.id,
    snippet: msg.data.snippet || "",
    subject: headerValue(headers, "Subject") || "",
    from: headerValue(headers, "From") || "",
    date: headerValue(headers, "Date") || "",
    body_text: bodyText || "(no text/plain part found)"
  };
}
