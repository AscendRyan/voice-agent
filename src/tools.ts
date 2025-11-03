// src/tools.ts
import { google } from "googleapis";

// Simple allowlist check for webhooks
function isAllowedWebhook(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const allow = (process.env.TOOL_WEBHOOK_ALLOWLIST || "")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    return allow.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type SendEmailArgs = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};
export type PostWebhookArgs = {
  url: string;
  json: Record<string, any>;
};

export async function sendEmailViaGmail(args: SendEmailArgs) {
  const { to, subject, text, html } = args;
  if (!to || !subject || (!text && !html)) {
    throw new Error("Missing required email fields: to, subject, and text or html.");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN!;
  const sender = process.env.GMAIL_SENDER!;
  if (!clientId || !clientSecret || !refreshToken || !sender) {
    throw new Error("Gmail env vars missing. Set GOOGLE_CLIENT_ID/SECRET, GOOGLE_REFRESH_TOKEN, GMAIL_SENDER.");
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // Build RFC2822 email
  const messageParts = [
    `From: ${sender}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    html
      ? 'Content-Type: text/html; charset=UTF-8'
      : 'Content-Type: text/plain; charset=UTF-8',
    "",
    html ?? text ?? "",
  ];
  const message = messageParts.join("\r\n");
  const encodedMessage = Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodedMessage },
  });

  return {
    id: res.data.id,
    labelIds: res.data.labelIds,
    threadId: res.data.threadId,
    status: "sent",
  };
}

export async function postWebhook(args: PostWebhookArgs) {
  const { url, json } = args;
  if (!isAllowedWebhook(url)) {
    throw new Error(`URL not in allowlist: ${url}`);
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(json ?? {}),
  });
  const bodyText = await res.text().catch(() => "");
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    body: bodyText.slice(0, 2000), // don’t flood logs
  };
}

// Realtime tool **schemas** (JSON Schema) that we’ll attach to the session
export const TOOL_DEFS = [
  {
    type: "function",
    name: "send_email",
    description: "Send an email via Gmail. Use for short transactional messages.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
      },
      required: ["to", "subject"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "post_webhook",
    description: "POST a JSON payload to an allow-listed URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS URL (must be allow-listed)" },
        json: { type: "object" },
      },
      required: ["url", "json"],
      additionalProperties: false,
    },
  },
] as const;
