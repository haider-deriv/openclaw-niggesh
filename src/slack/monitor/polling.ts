/**
 * Polling mode for Slack - allows receiving messages as a user (not a bot)
 * using the conversations.history API instead of Socket Mode/Events API.
 */

import { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../types.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackMessageHandler } from "./message-handler.js";

export interface PollingConfig {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
  userToken: string;
  myUserId: string;
  pollInterval: number; // in seconds
  abortSignal?: AbortSignal;
}

// Track processed messages to avoid duplicates
const processedMessages = new Set<string>();

// Track discovered channels
const discoveredChannels = new Set<string>();

/**
 * Get all DM channels for the user
 */
async function getDmChannels(client: WebClient): Promise<string[]> {
  const channels: string[] = [];
  try {
    const response = await client.conversations.list({
      types: "im,mpim",
      limit: 100,
    });
    if (response.ok && response.channels) {
      for (const ch of response.channels) {
        if (ch.id) {
          channels.push(ch.id);
          if (!discoveredChannels.has(ch.id)) {
            discoveredChannels.add(ch.id);
          }
        }
      }
    }
  } catch (err) {
    // Log but don't throw - we'll retry on next poll
    console.error("Error fetching DM channels:", err);
  }
  return channels;
}

/**
 * Poll a single channel for new messages
 */
async function pollChannel(
  client: WebClient,
  channelId: string,
  myUserId: string,
  handleSlackMessage: SlackMessageHandler,
): Promise<void> {
  try {
    const response = await client.conversations.history({
      channel: channelId,
      limit: 5,
    });

    if (!response.ok || !response.messages) {
      return;
    }

    for (const msg of response.messages) {
      const ts = msg.ts;
      const userId = msg.user;
      const text = msg.text;
      const subtype = msg.subtype;

      // Skip if already processed
      if (!ts || processedMessages.has(ts)) {
        continue;
      }

      // Skip own messages
      if (userId === myUserId) {
        processedMessages.add(ts);
        continue;
      }

      // Skip bot messages
      if (msg.bot_id || subtype === "bot_message") {
        processedMessages.add(ts);
        continue;
      }

      // Skip empty or subtyped messages (joins, leaves, etc.)
      if (!text || !text.trim() || subtype) {
        processedMessages.add(ts);
        continue;
      }

      // Skip old messages (older than 24 hours)
      const messageTime = parseFloat(ts);
      const ageHours = (Date.now() / 1000 - messageTime) / 3600;
      if (ageHours > 24) {
        processedMessages.add(ts);
        continue;
      }

      // Mark as processed before handling
      processedMessages.add(ts);

      // Convert to SlackMessageEvent format
      const slackEvent: SlackMessageEvent = {
        type: "message",
        channel: channelId,
        user: userId || "",
        text: text,
        ts: ts,
        event_ts: ts,
        channel_type: "im",
        // Include thread_ts if it's a threaded reply
        ...(msg.thread_ts && msg.thread_ts !== ts ? { thread_ts: msg.thread_ts } : {}),
      };

      // Handle the message using existing handler
      try {
        await handleSlackMessage(slackEvent, { source: "message" });
      } catch (err) {
        console.error(`Error handling message in ${channelId}:`, err);
      }
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Rate limiting - log but don't spam
    if (errorMessage.includes("ratelimited")) {
      console.warn(`Rate limited polling ${channelId}, will retry later`);
    } else {
      console.error(`Error polling channel ${channelId}:`, err);
    }
  }
}

/**
 * Main polling loop
 */
async function pollingLoop(config: PollingConfig): Promise<void> {
  const { ctx, handleSlackMessage, userToken, myUserId, pollInterval, abortSignal } = config;

  const client = new WebClient(userToken);

  ctx.runtime.log?.(`slack polling mode started (interval: ${pollInterval}s, user: ${myUserId})`);

  while (!abortSignal?.aborted) {
    try {
      const channels = await getDmChannels(client);

      for (const channelId of channels) {
        if (abortSignal?.aborted) break;
        await pollChannel(client, channelId, myUserId, handleSlackMessage);
      }
    } catch (err) {
      console.error("Polling loop error:", err);
    }

    // Wait for next poll interval
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, pollInterval * 1000);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
  }

  ctx.runtime.log?.("slack polling mode stopped");
}

/**
 * Start the polling loop for user token mode
 */
export function startPollingLoop(config: PollingConfig): void {
  // Run polling in background
  void pollingLoop(config);
}

/**
 * Clear processed messages cache (useful for testing)
 */
export function clearProcessedMessages(): void {
  processedMessages.clear();
}
