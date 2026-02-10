/**
 * MCP Configuration Module
 *
 * Environment variable configuration for MCP (Model Context Protocol) modules:
 * - OMC_MCP_OUTPUT_PATH_POLICY=strict|redirect_output (default: strict)
 * - OMC_MCP_OUTPUT_REDIRECT_DIR=.omc/outputs (default: .omc/outputs)
 * - OMC_MCP_ALLOW_EXTERNAL_PROMPT=0|1 (default: 0)
 *
 * This module provides policy resolution and path redirection logic
 * accessible from both codex-core.ts and gemini-core.ts.
 */

import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname, isAbsolute, join } from 'path';

/**
 * Output path policy types
 */
export type OutputPathPolicy = 'strict' | 'redirect_output';

/**
 * MCP Configuration interface
 */
export interface McpConfig {
  /** Output path policy: strict (enforce boundaries) or redirect_output (redirect to safe dir) */
  outputPathPolicy: OutputPathPolicy;
  /** Directory to redirect outputs when policy is 'redirect_output' */
  outputRedirectDir: string;
  /** Whether to allow external prompt file access (outside working directory) */
  allowExternalPrompt: boolean;
}

/**
 * Default MCP configuration values
 */
export const DEFAULT_MCP_CONFIG: McpConfig = {
  outputPathPolicy: 'strict',
  outputRedirectDir: '.omc/outputs',
  allowExternalPrompt: false,
};

/**
 * Parse environment variable to OutputPathPolicy
 */
function parseOutputPathPolicy(value: string | undefined): OutputPathPolicy {
  if (value === 'redirect_output') {
    return 'redirect_output';
  }
  // Default to strict for any other value (including undefined)
  return 'strict';
}

/**
 * Parse boolean-like environment variable (0|1, true|false)
 */
function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Load MCP configuration from environment variables
 */
export function loadMcpConfig(): McpConfig {
  const outputPathPolicy = parseOutputPathPolicy(process.env.OMC_MCP_OUTPUT_PATH_POLICY);
  const outputRedirectDir = process.env.OMC_MCP_OUTPUT_REDIRECT_DIR || DEFAULT_MCP_CONFIG.outputRedirectDir;
  const allowExternalPrompt = parseBooleanEnv(process.env.OMC_MCP_ALLOW_EXTERNAL_PROMPT, DEFAULT_MCP_CONFIG.allowExternalPrompt);

  const config: McpConfig = {
    outputPathPolicy,
    outputRedirectDir,
    allowExternalPrompt,
  };

  // Log warning if external prompt access is enabled (security consideration)
  if (config.allowExternalPrompt) {
    console.warn('[MCP Config] WARNING: OMC_MCP_ALLOW_EXTERNAL_PROMPT is enabled. External prompt files outside the working directory are allowed. This may pose a security risk.');
  }

  return config;
}

/**
 * Cached configuration (lazy-loaded on first access)
 */
let cachedConfig: McpConfig | null = null;

/**
 * Get MCP configuration (cached)
 */
export function getMcpConfig(): McpConfig {
  if (!cachedConfig) {
    cachedConfig = loadMcpConfig();
  }
  return cachedConfig;
}

/**
 * Clear the cached configuration (useful for testing)
 */
export function clearMcpConfigCache(): void {
  cachedConfig = null;
}

/**
 * Redirect an output file path to the configured redirect directory.
 *
 * When outputPathPolicy is 'redirect_output', this function:
 * 1. Takes the original output_file path
 * 2. Extracts just the filename
 * 3. Places it in the configured redirect directory
 * 4. Creates the directory if it doesn't exist
 *
 * @param outputFile - The original output file path
 * @param baseDir - The base working directory for resolving relative paths
 * @returns The actual path to use (redirected or original)
 */
export function redirectOutputPath(outputFile: string, baseDir: string = process.cwd()): string {
  const config = getMcpConfig();

  // If policy is strict, return the original path unchanged
  if (config.outputPathPolicy === 'strict') {
    return outputFile;
  }

  // For redirect_output policy, redirect to the configured directory
  const redirectDir = isAbsolute(config.outputRedirectDir)
    ? config.outputRedirectDir
    : resolve(baseDir, config.outputRedirectDir);

  // Ensure the redirect directory exists
  if (!existsSync(redirectDir)) {
    try {
      mkdirSync(redirectDir, { recursive: true });
    } catch (err) {
      console.warn(`[MCP Config] Failed to create redirect directory '${redirectDir}': ${(err as Error).message}`);
      // Fall back to original path if we can't create the directory
      return outputFile;
    }
  }

  // Extract the filename from the original path
  const filename = outputFile.split('/').pop()?.split('\\').pop() || 'output.txt';

  // Build the new path in the redirect directory
  const redirectedPath = join(redirectDir, filename);

  console.log(`[MCP Config] Redirecting output from '${outputFile}' to '${redirectedPath}'`);

  return redirectedPath;
}

/**
 * Check if external prompt access is allowed
 */
export function isExternalPromptAllowed(): boolean {
  return getMcpConfig().allowExternalPrompt;
}

/**
 * Get the current output path policy
 */
export function getOutputPathPolicy(): OutputPathPolicy {
  return getMcpConfig().outputPathPolicy;
}

/**
 * Get the configured output redirect directory
 */
export function getOutputRedirectDir(): string {
  return getMcpConfig().outputRedirectDir;
}
