/**
 * LinkedIn Channel Configuration Schema
 *
 * Defines the Zod schema for channels.linkedin.* configuration.
 * Credentials can be specified here or fall back to tools.linkedin.*.
 */

import { z } from "zod";
import { DmPolicySchema, requireOpenAllowFrom } from "./zod-schema.core.js";

/**
 * LinkedIn channel account configuration schema.
 */
export const LinkedInChannelAccountSchemaBase = z.object({
  /** If false, do not start this LinkedIn account. Default: true. */
  enabled: z.boolean().optional(),
  /** Display name for this account. */
  name: z.string().optional(),
  /** DM policy: "open", "pairing", or "allowlist". Default: "pairing". */
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  /** List of allowed sender IDs (LinkedIn provider IDs). */
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  /** Unipile DSN base URL (e.g., "api1.unipile.com:13111"). Falls back to tools.linkedin.baseUrl or UNIPILE_BASE_URL. */
  baseUrl: z.string().optional(),
  /** Unipile API key for authentication. Falls back to tools.linkedin.apiKey or UNIPILE_API_KEY. */
  apiKey: z.string().optional(),
  /** LinkedIn account ID on Unipile platform. Falls back to tools.linkedin.accountId or UNIPILE_ACCOUNT_ID. */
  accountId: z.string().optional(),
  /** Request timeout in milliseconds. Default: 30000. */
  timeoutMs: z.number().int().positive().optional(),
  /** Optional webhook secret for verifying incoming webhooks. */
  webhookSecret: z.string().optional(),
  /** Custom webhook path (default: /linkedin/webhook). */
  webhookPath: z.string().optional(),
  /** History limit for message retrieval. */
  historyLimit: z.number().int().min(0).optional(),
});

export const LinkedInChannelAccountSchema = LinkedInChannelAccountSchemaBase.superRefine(
  (value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.linkedin.dmPolicy="open" requires channels.linkedin.allowFrom to include "*"',
    });
  },
);

/**
 * LinkedIn channel configuration schema (with multi-account support).
 */
export const LinkedInChannelConfigSchema = LinkedInChannelAccountSchemaBase.extend({
  /** Per-account LinkedIn configuration (multi-account support). */
  accounts: z.record(z.string(), LinkedInChannelAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message:
      'channels.linkedin.dmPolicy="open" requires channels.linkedin.allowFrom to include "*"',
  });

  // Validate per-account settings
  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    // Add any account-specific validation here if needed
  }
});
