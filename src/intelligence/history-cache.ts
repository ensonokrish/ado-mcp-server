/**
 * Historical Data Cache
 * Loaded on connect — stores board data for intelligent suggestions.
 * Builds feature mappings, assignee patterns, and recent items from live data.
 */

import { AdoClient } from "../api/ado-client.js";
import { getAreaPath } from "../config/index.js";
import { getStoryType } from "../config/index.js";

export interface HistoricalItem {
  id: number;
  title: string;
  assignee: string;
  state: string;
  tags: string;
  parentId?: number;
  boardColumn: string;
}

export interface FeatureInfo {
  id: number;
  title: string;
  childTitles: string[];
}

export interface AssigneeStats {
  name: string;
  totalItems: number;
  keywords: string[];
}

interface HistoricalCache {
  loaded: boolean;
  loadedAt: string;
  features: FeatureInfo[];
  recentItems: HistoricalItem[];
  assigneePatterns: AssigneeStats[];
  productTags: string[];
  currentIteration: { name: string; path: string } | null;
}

let cache: HistoricalCache = {
  loaded: false,
  loadedAt: "",
  features: [],
  recentItems: [],
  assigneePatterns: [],
  productTags: [],
  currentIteration: null,
};

export function getCache(): HistoricalCache {
  return cache;
}

export function isCacheLoaded(): boolean {
  return cache.loaded;
}

/**
 * Load historical data from ADO board on connect.
 */
export async function loadHistoricalData(client: AdoClient, project?: string): Promise<string> {
  const areaPath = getAreaPath() || project;

  if (!areaPath) {
    return "Skipped — no area_path or project available";
  }

  try {
    // 1. Load active features and epics
    const featuresResult = await client.queryByWiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER '${areaPath}' AND ([System.WorkItemType] = 'Feature' OR [System.WorkItemType] = 'Epic') AND [System.State] <> 'Closed' AND [System.State] <> 'Removed'`,
      project,
      100
    );

    let features: FeatureInfo[] = [];
    if (featuresResult.workItems.length > 0) {
      const featureIds = featuresResult.workItems.map((wi) => wi.id);
      const featureItems = await client.getWorkItems(featureIds, project, [
        "System.Id",
        "System.Title",
      ]);
      features = featureItems.map((wi) => ({
        id: wi.id,
        title: wi.fields["System.Title"] as string,
        childTitles: [],
      }));
    }

    // 2. Load recent closed items (last 90 days) to learn patterns
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const recentResult = await client.queryByWiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.AreaPath] UNDER '${areaPath}' AND [System.WorkItemType] = '${getStoryType()}' AND [System.ChangedDate] >= '${since}' ORDER BY [System.ChangedDate] DESC`,
      project,
      200
    );

    let recentItems: HistoricalItem[] = [];
    if (recentResult.workItems.length > 0) {
      const ids = recentResult.workItems.map((wi) => wi.id).slice(0, 200);
      const items = await client.getWorkItems(ids, project, [
        "System.Id",
        "System.Title",
        "System.AssignedTo",
        "System.State",
        "System.Tags",
        "System.BoardColumn",
      ]);

      recentItems = items.map((wi) => ({
        id: wi.id,
        title: (wi.fields["System.Title"] as string) || "",
        assignee: (wi.fields["System.AssignedTo"] as { displayName?: string })?.displayName || "Unassigned",
        state: (wi.fields["System.State"] as string) || "",
        tags: (wi.fields["System.Tags"] as string) || "",
        boardColumn: (wi.fields["System.BoardColumn"] as string) || "",
      }));
    }

    // 3. Build assignee patterns from historical data
    const assigneeMap: Record<string, { count: number; titles: string[] }> = {};
    for (const item of recentItems) {
      if (item.assignee && item.assignee !== "Unassigned") {
        if (!assigneeMap[item.assignee]) {
          assigneeMap[item.assignee] = { count: 0, titles: [] };
        }
        assigneeMap[item.assignee].count++;
        assigneeMap[item.assignee].titles.push(item.title.toLowerCase());
      }
    }

    // Extract top keywords per assignee
    const assigneePatterns: AssigneeStats[] = Object.entries(assigneeMap).map(([name, data]) => {
      const wordFreq: Record<string, number> = {};
      const stopWords = ["the", "and", "for", "from", "with", "all", "new", "fix", "add", "create", "update", "to", "in", "on", "of", "a"];
      for (const title of data.titles) {
        const words = title.split(/\s+/).filter((w) => w.length > 3 && !stopWords.includes(w));
        for (const word of words) {
          wordFreq[word] = (wordFreq[word] || 0) + 1;
        }
      }
      const topKeywords = Object.entries(wordFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word]) => word);

      return { name, totalItems: data.count, keywords: topKeywords };
    });

    // 4. Extract product tags from recent items (most frequent tags)
    const tagFreq: Record<string, number> = {};
    for (const item of recentItems) {
      if (item.tags) {
        for (const tag of item.tags.split(";").map((t) => t.trim()).filter(Boolean)) {
          tagFreq[tag] = (tagFreq[tag] || 0) + 1;
        }
      }
    }
    const productTags = Object.entries(tagFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag]) => tag);

    // 5. Detect current iteration from project's iterations
    let currentIteration: { name: string; path: string } | null = null;
    try {
      const iterations = await client.getIterations(project);
      const now = new Date();
      for (const iter of iterations) {
        const attrs = iter.attributes as { startDate?: string; finishDate?: string } | undefined;
        if (attrs?.startDate && attrs?.finishDate) {
          const start = new Date(attrs.startDate);
          const end = new Date(attrs.finishDate);
          if (now >= start && now <= end) {
            currentIteration = { name: iter.name, path: iter.path };
            break;
          }
        }
      }
    } catch {
      // Non-critical — iteration detection is best-effort
    }

    // Update cache
    cache = {
      loaded: true,
      loadedAt: new Date().toISOString(),
      features,
      recentItems,
      assigneePatterns,
      productTags,
      currentIteration,
    };

    return `Loaded ${features.length} features, ${recentItems.length} recent items, ${assigneePatterns.length} team members`;
  } catch (err) {
    return `Warning: Could not load historical data: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Suggest parent feature by matching title against active features.
 */
export function suggestFeatureFromCache(title: string): { id: number; name: string; confidence: string } | undefined {
  const lowerTitle = title.toLowerCase();

  // First try: exact keyword match against feature titles
  for (const feature of cache.features) {
    const featureWords = feature.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const matchCount = featureWords.filter((w) => lowerTitle.includes(w)).length;
    if (matchCount >= 2) {
      return { id: feature.id, name: feature.title, confidence: "high" };
    }
  }

  // Second try: single strong keyword match
  for (const feature of cache.features) {
    const featureWords = feature.title.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    for (const word of featureWords) {
      if (lowerTitle.includes(word) && !["management", "engineering", "support"].includes(word)) {
        return { id: feature.id, name: feature.title, confidence: "medium" };
      }
    }
  }

  return undefined;
}

/**
 * Suggest assignee by matching title keywords against historical patterns.
 */
export function suggestAssigneeFromCache(title: string): { name: string; confidence: string; reason: string } | undefined {
  const lowerTitle = title.toLowerCase();
  let bestMatch: { name: string; score: number; keyword: string } | undefined;

  for (const { name, keywords } of cache.assigneePatterns) {
    for (const kw of keywords) {
      if (lowerTitle.includes(kw)) {
        const score = kw.length; // longer keyword = more specific match
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { name, score, keyword: kw };
        }
      }
    }
  }

  if (bestMatch) {
    return {
      name: bestMatch.name,
      confidence: bestMatch.score > 6 ? "high" : "medium",
      reason: `Historically works on "${bestMatch.keyword}" items`,
    };
  }

  return undefined;
}

/**
 * Get dynamically detected product tags from recent work items.
 */
export function getDetectedProductTags(): string[] {
  return cache.productTags;
}

/**
 * Get the dynamically detected current iteration.
 */
export function getDetectedIteration(): { name: string; path: string } | null {
  return cache.currentIteration;
}
