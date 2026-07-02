/**
 * Platform adapter factory and auto-detection logic.
 */

import type { Platform, PlatformAdapter, AdapterFactory } from "./types.js";

export type { PlatformAdapter, Platform };

// GitHub adapter will be imported dynamically to avoid circular deps
let githubAdapter: PlatformAdapter | null = null;
let giteaAdapter: PlatformAdapter | null = null;

async function getGitHubAdapter(): Promise<PlatformAdapter> {
  if (!githubAdapter) {
    const { GitHubAdapter } = await import("./github/adapter.js");
    githubAdapter = new GitHubAdapter();
  }
  return githubAdapter;
}

async function getGiteaAdapter(): Promise<PlatformAdapter> {
  if (!giteaAdapter) {
    const { GiteaAdapter } = await import("./gitea/adapter.js");
    giteaAdapter = new GiteaAdapter();
  }
  return giteaAdapter;
}

/**
 * Create a platform adapter for the specified platform.
 * @throws Error if platform is not supported
 */
export async function createAdapter(platform: Platform): Promise<PlatformAdapter> {
  switch (platform) {
    case "github":
      return getGitHubAdapter();
    case "gitea":
      return getGiteaAdapter();
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Auto-detect the platform from environment variables.
 * Priority: CLI arg > GITEA_* > GITHUB_*
 * @param env Process environment variables
 * @param explicitPlatform Optional explicit platform from CLI
 * @returns Detected platform or null if detection fails
 */
export function detectPlatform(
  env: NodeJS.ProcessEnv,
  explicitPlatform?: string,
): Platform | null {
  // 1. Explicit CLI argument takes precedence
  if (explicitPlatform) {
    const p = explicitPlatform.toLowerCase();
    if (p === "github" || p === "gitea") return p;
    return null; // Invalid platform specified
  }

  // 2. Check GITEA_* environment variables
  if (env.GITEA_URL || env.GITEA_TOKEN) {
    return "gitea";
  }

  // 3. Check GITHUB_* environment variables
  if (env.GITHUB_REPOSITORY || env.GITHUB_TOKEN) {
    return "github";
  }

  // 4. No platform detected
  return null;
}

/**
 * Create a platform adapter with auto-detection.
 * @param env Process environment variables
 * @param explicitPlatform Optional explicit platform from CLI
 * @throws Error if no platform detected or platform is invalid
 */
export async function createAdapterFromEnv(
  env: NodeJS.ProcessEnv,
  explicitPlatform?: string,
): Promise<{ adapter: PlatformAdapter; platform: Platform }> {
  const platform = detectPlatform(env, explicitPlatform);
  if (!platform) {
    if (explicitPlatform) {
      throw new Error(`Invalid platform: ${explicitPlatform}. Supported: github, gitea`);
    }
    throw new Error(
      "No platform detected. Set GITEA_URL/GITEA_TOKEN for Gitea or GITHUB_REPOSITORY/GITHUB_TOKEN for GitHub, or use --platform flag."
    );
  }
  const adapter = await createAdapter(platform);
  return { adapter, platform };
}
