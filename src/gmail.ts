import { google } from "googleapis";

export function makeGmailClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const refresh = process.env.GMAIL_REFRESH_TOKEN!;
  const user = process.env.GMAIL_USER!;
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
  oAuth2Client.setCredentials({ refresh_token: refresh });
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  return { gmail, user };
}

export async function gmailSearch(query: string, maxResults = 5) {
  const { gmail, user } = makeGmailClient();
  const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
  const ids = (res.data.messages || []).map((m) => m.id!).filter(Boolean);
  const messages = [];
  for (const id of ids) {
    const m = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
    messages.push({
      id,
      snippet: m.data.snippet || "",
      headers: Object.fromEntries((m.data.payload?.headers || []).map(h => [h.name!, h.value!])),
    });
  }
  return { account: user, query, messages };
}

export async function gmailRead(id: string) {
  const { gmail, user } = makeGmailClient();
  const m = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  return {
    account: user,
    id,
    snippet: m.data.snippet || "",
    headers: Object.fromEntries((m.data.payload?.headers || []).map(h => [h.name!, h.value!])),
    body: extractPlainText(m.data),
  };
}

export async function gmailSend(to: string, subject: string, body: string) {
  const { gmail, user } = makeGmailClient();
  const raw = buildRawEmail(user, to, subject, body);
  await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return { sent: true, from: user, to, subject };
}

function buildRawEmail(from: string, to: string, subject: string, body: string) {
  const message =
`From: ${from}
To: ${to}
Subject: ${subject}
MIME-Version: 1.0
Content-Type: text/plain; charset="UTF-8"

${body}`;
  return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function extractPlainText(msg: any): string {
  const parts = msg.payload?.parts;
  if (!parts) {
    const data = msg.payload?.body?.data;
    return data ? Buffer.from(data, "base64").toString("utf8") : "";
  }
  // find text/plain
  for (const p of parts) {
    if (p.mimeType === "text/plain" && p.body?.data) {
      return Buffer.from(p.body.data, "base64").toString("utf8");
    }
  }
  // fallback to snippet
  return msg.snippet || "";
}
