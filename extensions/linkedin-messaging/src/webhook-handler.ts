/**
 * LinkedIn Messaging Webhook Handler
 *
 * Handles incoming webhook events from Unipile for LinkedIn messages.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { normalizePluginHttpPath, registerPluginHttpRoute } from "openclaw/plugin-sdk";
import type { LinkedInWebhookPayload } from "../../../src/linkedin/types.js";
import type { ResolvedLinkedInAccount } from "./channel.js";
import { getLinkedInRuntime } from "./runtime.js";

export interface LinkedInWebhookHandlerOptions {
  account: ResolvedLinkedInAccount;
  config: OpenClawConfig;
  abortSignal?: AbortSignal;
  webhookPath?: string;
  onMessage?: (payload: LinkedInWebhookPayload) => Promise<void>;
}

export interface LinkedInWebhookHandler {
  path: string;
  stop: () => void;
}

// Track runtime state in memory
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getLinkedInRuntimeState(accountId: string) {
  return runtimeState.get(`linkedin:${accountId}`);
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Validate Unipile webhook signature (if configured).
 * Unipile uses a simple shared secret validation.
 */
function validateWebhookSignature(
  _body: string,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) {
    // No secret configured, skip validation
    return true;
  }
  if (!signature) {
    return false;
  }
  // Unipile typically sends the secret as a header
  // Exact validation depends on Unipile's implementation
  return signature === secret;
}

/**
 * Start the LinkedIn webhook handler.
 */
export function startLinkedInWebhookHandler(
  opts: LinkedInWebhookHandlerOptions,
): LinkedInWebhookHandler {
  const { account, abortSignal, webhookPath, onMessage } = opts;
  const runtime = getLinkedInRuntime();

  // Record starting state
  recordChannelRuntimeState({
    channel: "linkedin",
    accountId: account.accountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // Register HTTP webhook handler
  const normalizedPath =
    normalizePluginHttpPath(webhookPath, "/linkedin/webhook") ?? "/linkedin/webhook";
  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "linkedin-messaging",
    accountId: account.accountId,
    log: (msg) => runtime.logging?.logVerbose?.(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Handle GET requests for webhook verification
      if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("OK");
        return;
      }

      // Only accept POST requests
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      try {
        const rawBody = await readRequestBody(req);
        const signature = req.headers["x-webhook-secret"] as string | undefined;

        // Validate signature if secret is configured
        if (!validateWebhookSignature(rawBody, signature, account.webhookSecret)) {
          runtime.logging?.logVerbose?.("linkedin: webhook signature validation failed");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        // Parse the webhook body
        const payload = JSON.parse(rawBody) as LinkedInWebhookPayload;

        // Record inbound activity
        recordChannelRuntimeState({
          channel: "linkedin",
          accountId: account.accountId,
          state: {
            lastInboundAt: Date.now(),
          },
        });

        // Respond immediately with 200 to avoid timeout
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));

        // Log the incoming message
        runtime.logging?.logVerbose?.(
          `linkedin: received message from ${payload.sender?.name ?? payload.sender?.id ?? "unknown"}`,
        );

        // Process the message asynchronously
        if (onMessage) {
          await onMessage(payload).catch((err) => {
            runtime.logging?.error?.(`linkedin webhook handler failed: ${String(err)}`);
          });
        }
      } catch (err) {
        runtime.logging?.error?.(`linkedin webhook error: ${String(err)}`);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    },
  });

  runtime.logging?.logVerbose?.(`linkedin: registered webhook handler at ${normalizedPath}`);

  // Handle abort signal
  const stopHandler = () => {
    runtime.logging?.logVerbose?.(
      `linkedin: stopping webhook handler for account ${account.accountId}`,
    );
    unregisterHttp();
    recordChannelRuntimeState({
      channel: "linkedin",
      accountId: account.accountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  abortSignal?.addEventListener("abort", stopHandler);

  return {
    path: normalizedPath,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}

/**
 * Process an incoming LinkedIn message and dispatch to the auto-reply system.
 */
export async function processLinkedInMessage(
  payload: LinkedInWebhookPayload,
  account: ResolvedLinkedInAccount,
  config: OpenClawConfig,
): Promise<void> {
  const runtime = getLinkedInRuntime();

  // Skip if it's our own message
  if (payload.is_sender) {
    runtime.logging?.logVerbose?.("linkedin: skipping own message");
    return;
  }

  // Build context payload for the auto-reply system
  const ctxPayload = {
    // Standard context fields
    From: payload.sender?.id ?? "",
    To: account.unipileAccountId,
    Body: payload.message ?? "",
    Provider: "linkedin",
    AccountId: account.accountId,
    MessageId: payload.message_id,
    ChatId: payload.chat_id,
    Timestamp: payload.timestamp,
    // LinkedIn-specific fields
    SenderName: payload.sender?.name,
    IsGroup: payload.is_group ?? false,
    MessageType: payload.message_type ?? "MESSAGE",
    Attachments: payload.attachments,
  };

  // TODO: Dispatch to auto-reply system
  // This will be similar to LINE's dispatchReplyWithBufferedBlockDispatcher
  // For now, just log the message
  runtime.logging?.logVerbose?.(
    `linkedin: message from ${ctxPayload.SenderName ?? ctxPayload.From}: ${ctxPayload.Body.slice(0, 100)}`,
  );

  // The actual dispatch would look something like:
  // await dispatchReplyWithBufferedBlockDispatcher({
  //   ctx: ctxPayload,
  //   cfg: config,
  //   dispatcherOptions: { ... },
  // });
}
