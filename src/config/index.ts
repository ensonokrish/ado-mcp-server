/**
 * Configuration loader.
 * Reads config/defaults.json and provides typed access to settings.
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

/**
 * Load config from config/defaults.json.
 * Returns null if file doesn't exist (generic mode — no defaults enforced).
 */
export function loadConfig(): AppConfig | null {
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
 * Get area path from config, or return undefined for generic usage.
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
