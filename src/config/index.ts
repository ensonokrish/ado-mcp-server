/**
 * Configuration module.
 * Manages dynamic detection of project settings (story type, org context).
 * Optionally reads config/defaults.json if present (for team-specific overrides).
 */

import * as fs from "fs";
import * as path from "path";

export interface QuarterConfig {
  name: string;
  year: number;
  quarter_tag: string;
  iteration_path: string;
}

export interface AppConfig {
  organization: string;
  project: string;
  board: string;
  area_path: string;
  current_quarter: QuarterConfig;
  product_tags: string[];
  required_fields: {
    product_name: string;
    requestor_field: boolean;
  };
}

let configCache: AppConfig | null = null;

/** The org that is currently connected — set via setActiveOrg(). */
let activeOrg: string | null = null;

/**
 * Store the org the user connected to so config helpers can skip
 * defaults that belong to a different organisation.
 */
export function setActiveOrg(org: string): void {
  activeOrg = org;
}

/**
 * Returns true when defaults.json exists AND its organisation matches
 * the currently-connected org (case-insensitive).  When there is no
 * match the static config should be ignored — it belongs to another org.
 */
function configMatchesActiveOrg(): boolean {
  const config = loadConfigRaw();
  if (!config) return false;
  if (!activeOrg) return true; // no active org yet — allow
  if (!config.organization) return true; // config has no org — allow
  return config.organization.toLowerCase() === activeOrg.toLowerCase();
}

/**
 * Internal loader — always returns the raw file content (cached).
 */
function loadConfigRaw(): AppConfig | null {
  if (configCache) return configCache;

  const configPath = path.resolve(process.cwd(), "config", "defaults.json");

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    configCache = JSON.parse(raw) as AppConfig;
    return configCache;
  } catch {
    return null;
  }
}

/**
 * Load config from config/defaults.json.
 * Returns null if file doesn't exist, can't be parsed, OR
 * if the connected org doesn't match the org in the config.
 */
export function loadConfig(): AppConfig | null {
  if (!configMatchesActiveOrg()) return null;
  return loadConfigRaw();
}

/**
 * Get area path from config, or return undefined for generic usage.
 * Returns undefined when the connected org doesn't match the config org.
 */
export function getAreaPath(): string | undefined {
  const config = loadConfig();
  return config?.area_path;
}

/**
 * Get product tags from config.
 */
export function getProductTags(): string[] {
  const config = loadConfig();
  return config?.product_tags || [];
}

/**
 * Get current quarter config.
 */
export function getQuarterConfig(): QuarterConfig | undefined {
  const config = loadConfig();
  return config?.current_quarter;
}

/**
 * Clear cached config (for testing or reload).
 */
export function clearConfigCache(): void {
  configCache = null;
}

// ── Dynamic story-type detection ──────────────────────────

/**
 * Known "story-level" type names ordered by preference.
 * The first match found in the project's available types wins.
 */
const STORY_TYPE_CANDIDATES = [
  "Engineering Story",
  "Product Backlog Item",
  "User Story",
  "Story",
];

/** Cached story type for the active project. */
let cachedStoryType: string | null = null;

/**
 * Detect the story-level work item type for the connected project.
 * Call once on connect — result is cached for the session.
 */
export async function detectStoryType(
  availableTypes: { name: string }[]
): Promise<string> {
  const names = new Set(availableTypes.map((t) => t.name));
  for (const candidate of STORY_TYPE_CANDIDATES) {
    if (names.has(candidate)) {
      cachedStoryType = candidate;
      return cachedStoryType;
    }
  }
  // Fallback — use the first non-meta type that looks story-like, or default
  cachedStoryType = "User Story";
  return cachedStoryType;
}

/**
 * Get the detected story-level type. Falls back to 'User Story'
 * if detectStoryType hasn't been called yet.
 */
export function getStoryType(): string {
  return cachedStoryType || "User Story";
}

/**
 * Build a WIQL type filter for story-level items.
 * Returns e.g. `[System.WorkItemType] = 'User Story'`
 */
export function storyTypeFilter(): string {
  return `[System.WorkItemType] = '${getStoryType()}'`;
}
