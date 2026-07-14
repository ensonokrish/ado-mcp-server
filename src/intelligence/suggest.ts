/**
 * Suggestion utilities (non-cached, always available).
 * - Product tag detection from title
 * - Duplicate detection via live WIQL query
 */

import { AdoClient } from "../api/ado-client.js";
import { getAreaPath, getStoryType } from "../config/index.js";

/**
 * Suggest product tag based on title keywords.
 */
export function suggestProductTag(title: string): string | undefined {
  const lower = title.toLowerCase();

  if (lower.includes("gail") || lower.includes("ai analysis") || lower.includes("inference") || lower.includes("bedrock")) {
    return "GAIL";
  }
  if (lower.includes("aws") || lower.includes("dais") || lower.includes("cloudwatch") || lower.includes("s3 bucket")) {
    return "AWS";
  }
  if (lower.includes("aks") || lower.includes("release") || lower.includes("pipeline") || lower.includes("wiz") || lower.includes("cert")) {
    return "AD";
  }

  return undefined;
}

/**
 * Find potential duplicates by searching for similar titles.
 */
export async function findDuplicates(
  client: AdoClient,
  title: string,
  project?: string
): Promise<{ id: number; title: string; state: string }[]> {
  const stopWords = ["the", "and", "for", "from", "with", "all", "new", "fix", "add", "create", "update"];
  const words = title
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.includes(w.toLowerCase()))
    .slice(0, 3);

  if (words.length === 0) return [];

  const areaPath = getAreaPath();
  const areaFilter = areaPath
    ? `[System.AreaPath] UNDER '${areaPath}' AND`
    : "";
  const searchTerms = words.map((w) => `[System.Title] CONTAINS '${w}'`).join(" AND ");
  const wiql = `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE ${areaFilter} [System.WorkItemType] = '${getStoryType()}' AND ${searchTerms} AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`;

  try {
    const result = await client.queryByWiql(wiql, project, 5);
    if (result.workItems.length === 0) return [];

    const ids = result.workItems.map((wi) => wi.id);
    const items = await client.getWorkItems(ids, project, [
      "System.Id",
      "System.Title",
      "System.State",
    ]);

    return items.map((wi) => ({
      id: wi.id,
      title: wi.fields["System.Title"] as string,
      state: wi.fields["System.State"] as string,
    }));
  } catch {
    return [];
  }
}
