/**
 * ElevenLabs Agents - Webhook Handler
 *
 * Handles post-call webhooks from ElevenLabs with HMAC signature verification.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { ConversationDetails } from "./types.js";

// =============================================================================
// Signature Verification
// =============================================================================

/**
 * Parse the ElevenLabs-Signature header.
 * Format: t=<timestamp>,v1=<signature>
 */
function parseSignatureHeader(header: string): { timestamp: string; signature: string } | null {
  const parts: Record<string, string> = {};
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key && value) {
      parts[key.trim()] = value.trim();
    }
  }
  if (!parts.t || !parts.v1) {
    return null;
  }
  return { timestamp: parts.t, signature: parts.v1 };
}

/**
 * Validate ElevenLabs webhook signature using HMAC-SHA256.
 */
export function validateElevenLabsSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { ok: false, reason: "Invalid signature header format" };
  }

  const { timestamp, signature } = parsed;

  // Check timestamp to prevent replay attacks (allow 5 minute window)
  const timestampMs = parseInt(timestamp, 10) * 1000;
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  if (isNaN(timestampMs) || Math.abs(now - timestampMs) > fiveMinutes) {
    return { ok: false, reason: "Timestamp too old or invalid" };
  }

  // Compute expected signature: HMAC-SHA256(timestamp.rawBody)
  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  // Constant-time comparison
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const actualBuffer = Buffer.from(signature, "hex");

  if (expectedBuffer.length !== actualBuffer.length) {
    return { ok: false, reason: "Signature mismatch" };
  }

  if (!crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, reason: "Signature mismatch" };
  }

  return { ok: true };
}

// =============================================================================
// Webhook Payload Types
// =============================================================================

export type ElevenLabsWebhookPayload = {
  type?: string;
  event_timestamp?: number;
  data?: {
    conversation_id?: string;
    agent_id?: string;
    status?: string;
    transcript?: Array<{
      role: "agent" | "user";
      message: string;
      time_in_call_secs?: number;
    }>;
    analysis?: Record<string, unknown>;
    metadata?: {
      call_duration_secs?: number;
      start_time_unix_secs?: number;
      end_time_unix_secs?: number;
      [key: string]: unknown;
    };
  };
  // Flat structure (alternative format)
  conversation_id?: string;
  agent_id?: string;
  status?: string;
  transcript?: Array<{
    role: "agent" | "user";
    message: string;
    time_in_call_secs?: number;
  }>;
  analysis?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

// =============================================================================
// Webhook Handler
// =============================================================================

export type ElevenLabsWebhookHandlerOptions = {
  webhookSecret: string;
  webhookPath: string;
  onWebhook: (payload: {
    conversationId: string;
    status: string;
    transcript?: Array<{ role: string; message: string }>;
    analysis?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) => void;
};

/**
 * Read raw body from request.
 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Payload too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", reject);
  });
}

/**
 * Normalize webhook payload to consistent format.
 */
function normalizePayload(raw: ElevenLabsWebhookPayload): {
  conversationId: string;
  status: string;
  transcript?: Array<{ role: string; message: string }>;
  analysis?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
} | null {
  // Handle nested data structure
  const data = raw.data ?? raw;
  const conversationId = data.conversation_id;
  const status = data.status;

  if (!conversationId || typeof conversationId !== "string") {
    return null;
  }

  return {
    conversationId,
    status: typeof status === "string" ? status : "unknown",
    transcript: data.transcript?.map((t) => ({ role: t.role, message: t.message })),
    analysis: data.analysis,
    metadata: data.metadata,
  };
}

// =============================================================================
// Registry (similar to Slack pattern)
// =============================================================================

type RegisteredHandler = {
  path: string;
  secret: string;
  onWebhook: ElevenLabsWebhookHandlerOptions["onWebhook"];
};

let registeredHandler: RegisteredHandler | null = null;

/**
 * Register the ElevenLabs webhook handler.
 * Returns a cleanup function to unregister.
 */
export function registerElevenLabsWebhookHandler(
  opts: ElevenLabsWebhookHandlerOptions,
): () => void {
  registeredHandler = {
    path: opts.webhookPath,
    secret: opts.webhookSecret,
    onWebhook: opts.onWebhook,
  };
  return () => {
    registeredHandler = null;
  };
}

/**
 * Handle ElevenLabs webhook HTTP request.
 * Returns true if the request was handled (path matched), false otherwise.
 */
export async function handleElevenLabsWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!registeredHandler) {
    return false;
  }

  const { path: webhookPath, secret: webhookSecret, onWebhook } = registeredHandler;
  const maxBodyBytes = 1024 * 1024; // 1MB

  // Check path
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== webhookPath) {
    return false;
  }

  // Only accept POST
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  // Get signature header
  const signatureHeader = req.headers["elevenlabs-signature"];
  if (!signatureHeader || typeof signatureHeader !== "string") {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing ElevenLabs-Signature header" }));
    return true;
  }

  // Read body
  let rawBody: string;
  try {
    rawBody = await readRawBody(req, maxBodyBytes);
  } catch (err) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Payload too large" }));
    return true;
  }

  // Verify signature
  const verification = validateElevenLabsSignature(rawBody, signatureHeader, webhookSecret);
  if (!verification.ok) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: verification.reason }));
    return true;
  }

  // Parse payload
  let payload: ElevenLabsWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ElevenLabsWebhookPayload;
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return true;
  }

  // Normalize and validate
  const normalized = normalizePayload(payload);
  if (!normalized) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing conversation_id" }));
    return true;
  }

  // Respond immediately (ElevenLabs expects quick 200)
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));

  // Process webhook asynchronously
  try {
    onWebhook(normalized);
  } catch (err) {
    console.error("[elevenlabs-webhook] Handler error:", err);
  }

  return true;
}

/**
 * Create ElevenLabs webhook request handler for the gateway.
 * @deprecated Use registerElevenLabsWebhookHandler and handleElevenLabsWebhookRequest instead.
 */
export function createElevenLabsWebhookHandler(
  opts: ElevenLabsWebhookHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { webhookSecret, webhookPath, onWebhook } = opts;
  const maxBodyBytes = 1024 * 1024; // 1MB

  return async (req, res) => {
    // Check path
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== webhookPath) {
      return false;
    }

    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }

    // Get signature header
    const signatureHeader = req.headers["elevenlabs-signature"];
    if (!signatureHeader || typeof signatureHeader !== "string") {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing ElevenLabs-Signature header" }));
      return true;
    }

    // Read body
    let rawBody: string;
    try {
      rawBody = await readRawBody(req, maxBodyBytes);
    } catch (err) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Payload too large" }));
      return true;
    }

    // Verify signature
    const verification = validateElevenLabsSignature(rawBody, signatureHeader, webhookSecret);
    if (!verification.ok) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: verification.reason }));
      return true;
    }

    // Parse payload
    let payload: ElevenLabsWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as ElevenLabsWebhookPayload;
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }

    // Normalize and validate
    const normalized = normalizePayload(payload);
    if (!normalized) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing conversation_id" }));
      return true;
    }

    // Respond immediately (ElevenLabs expects quick 200)
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));

    // Process webhook asynchronously
    try {
      onWebhook(normalized);
    } catch (err) {
      console.error("[elevenlabs-webhook] Handler error:", err);
    }

    return true;
  };
}
