/**
 * Direct Call Registry
 *
 * Registry for functions that can be called directly by cron jobs
 * without agent involvement.
 */

import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob, DirectCallFunctionName } from "./types.js";

/**
 * Result returned by a direct call handler.
 */
export type DirectCallResult = {
  status: "ok" | "error";
  error?: string;
  /** Summary text for logging/delivery */
  summary?: string;
  /** Optional data to include in result */
  data?: Record<string, unknown>;
};

/**
 * Context passed to direct call handlers.
 */
export type DirectCallContext = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  workspaceDir: string;
};

/**
 * Handler function type for direct calls.
 */
export type DirectCallHandler = (
  params: Record<string, unknown>,
  context: DirectCallContext,
) => Promise<DirectCallResult>;

/**
 * Registry of direct call handlers.
 */
const registry = new Map<string, DirectCallHandler>();

/**
 * Register a direct call handler.
 */
export function registerDirectCallHandler(
  name: DirectCallFunctionName,
  handler: DirectCallHandler,
) {
  registry.set(name, handler);
}

/**
 * Get a direct call handler by name.
 */
export function getDirectCallHandler(name: string): DirectCallHandler | undefined {
  return registry.get(name);
}

/**
 * List all registered direct call function names.
 */
export function listDirectCallFunctions(): string[] {
  return Array.from(registry.keys());
}

/**
 * Check if a function name is registered.
 */
export function isDirectCallFunctionRegistered(name: string): boolean {
  return registry.has(name);
}
