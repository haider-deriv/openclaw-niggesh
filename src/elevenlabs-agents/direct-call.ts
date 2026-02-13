/**
 * ElevenLabs Direct Call Handler
 *
 * Handles direct call cron jobs for ElevenLabs without agent involvement.
 */

import type { DirectCallContext, DirectCallResult } from "../cron/direct-call-registry.js";
import { registerDirectCallHandler } from "../cron/direct-call-registry.js";
import { DirectCallFunctionName } from "../cron/types.js";
import { buildClientOptions, initiateOutboundCall } from "./client.js";
import { resolveElevenLabsAgentsConfig } from "./config.js";
import {
  createInitialStoredConversation,
  getPreviousCallSummary,
  saveConversation,
} from "./store.js";

/**
 * Execute a direct ElevenLabs call (no agent involvement).
 */
async function executeDirectElevenLabsCall(
  params: Record<string, unknown>,
  context: DirectCallContext,
): Promise<DirectCallResult> {
  const { cfg, workspaceDir, job } = context;

  // Extract params
  const toNumber = params.toNumber as string | undefined;
  const dynamicVariables = params.dynamicVariables as Record<string, string> | undefined;
  const originalConversationId = params.originalConversationId as string | undefined;

  if (!toNumber) {
    return { status: "error", error: "toNumber is required" };
  }

  // Resolve ElevenLabs config
  const resolvedConfig = resolveElevenLabsAgentsConfig(cfg);
  if (!resolvedConfig.agentId || !resolvedConfig.phoneNumberId || !resolvedConfig.apiKey) {
    return {
      status: "error",
      error: "ElevenLabs not configured (missing agentId, phoneNumberId, or apiKey)",
    };
  }

  const clientOpts = buildClientOptions(resolvedConfig);
  if (!clientOpts) {
    return {
      status: "error",
      error: "Failed to build ElevenLabs client options",
    };
  }

  try {
    // Merge dynamic variables with defaults and previous call summary
    const mergedVariables: Record<string, string> = {
      ...resolvedConfig.defaultDynamicVariables,
      ...dynamicVariables,
    };

    // Look up previous call summary for this phone number
    const previousSummary = await getPreviousCallSummary(workspaceDir, toNumber);
    if (previousSummary) {
      mergedVariables.previous_call_summary = previousSummary;
    } else {
      mergedVariables.previous_call_summary = "This is a scheduled callback.";
    }

    // Add reference to original conversation if provided
    if (originalConversationId) {
      mergedVariables.callback_for_conversation = originalConversationId;
    }

    // Initiate the call
    const response = await initiateOutboundCall(clientOpts, {
      agentId: resolvedConfig.agentId,
      phoneNumberId: resolvedConfig.phoneNumberId,
      toNumber,
      dynamicVariables: Object.keys(mergedVariables).length > 0 ? mergedVariables : undefined,
    });

    if (!response.conversation_id) {
      return { status: "error", error: "Call initiation failed: no conversation ID returned" };
    }

    const conversationId = response.conversation_id;

    // Save initial conversation record
    const storedConversation = createInitialStoredConversation({
      toNumber,
      dynamicVariables: mergedVariables,
    });
    await saveConversation(workspaceDir, conversationId, storedConversation);

    const candidateName = mergedVariables.candidate_name || toNumber;
    return {
      status: "ok",
      summary: `Callback initiated to ${candidateName} (${toNumber}). Conversation: ${conversationId}`,
      data: {
        conversationId,
        toNumber,
        originalConversationId,
      },
    };
  } catch (err) {
    return {
      status: "error",
      error: `Failed to initiate callback: ${String(err)}`,
    };
  }
}

// Register the handler on module load
registerDirectCallHandler(
  DirectCallFunctionName.ELEVENLABS_INITIATE_CALL,
  executeDirectElevenLabsCall,
);
