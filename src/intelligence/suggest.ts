/**
 * Historical Intelligence Module
 * Analyzes past work items to suggest defaults for new items.
 * - Parent feature detection based on title keywords
 * - Assignee suggestion based on historical patterns
 * - Duplicate detection
 */

import { AdoClient } from "../api/ado-client.js";

// Keyword → Feature mapping based on historical patterns
const FEATURE_KEYWORDS: { keywords: string[]; featureId: number; featureName: string }[] = [
  { keywords: ["release cut", "release candidate", "RC cut"], featureId: 485330, featureName: "Release 26.9 Management & Engineering" },
  { keywords: ["preprod", "pre-prod", "preprod upgrade"], featureId: 485330, featureName: "Release 26.9 Management & Engineering" },
  { keywords: ["predemo", "pre-demo"], featureId: 485330, featureName: "Release 26.9 Management & Engineering" },
  { keywords: ["prod release", "production release"], featureId: 485330, featureName: "Release 26.9 Management & Engineering" },
  { keywords: ["release prep"], featureId: 485330, featureName: "Release 26.9 Management & Engineering" },
  { keywords: ["migration test"], featureId: 485330, featureName: "Release 26.9 Management & Engineering" },
  { keywords: ["pipeline", "ci/cd", "ci cd", "orchestrator", "harness"], featureId: 485339, featureName: "New Pipeline Creation & Delivery" },
  { keywords: ["gail v2", "gail environment", "gail service"], featureId: 485341, featureName: "GAIL AI Services, Environments, and Overrides" },
  { keywords: ["gail prod", "gail release", "gail deploy"], featureId: 485341, featureName: "GAIL AI Services, Environments, and Overrides" },
  { keywords: ["dr test", "dr exercise", "disaster recovery", "failover"], featureId: 485347, featureName: "KTLO - DR Testing and Enhancement" },
  { keywords: ["saturn"], featureId: 485351, featureName: "Saturn On-call Support" },
  { keywords: ["aks upgrade", "kubernetes upgrade", "k8s upgrade"], featureId: 485359, featureName: "Upgrade AKS Version" },
  { keywords: ["postgres", "psql", "sku upgrade"], featureId: 485361, featureName: "Postgres V4 to V5 SKU Upgrade" },
  { keywords: ["wiz", "wiz sensor", "wiz setup"], featureId: 485362, featureName: "Addressing AD Wiz Issues" },
  { keywords: ["d4c", "public access", "storage account"], featureId: 485365, featureName: "Addressing AD D4C" },
  { keywords: ["ssl cert", "certificate renew", "cert update"], featureId: 485375, featureName: "Renew SSL Certs" },
  { keywords: ["cve", "remediat", "security patch", "vmss"], featureId: 485377, featureName: "KTLO - Infrastructure Management, Security & Compliance" },
  { keywords: ["runbook", "documentation", "knowledge"], featureId: 485380, featureName: "Runbook Creation & Knowledge Documentation" },
  { keywords: ["aws infra", "inference profile", "bedrock", "dais"], featureId: 485387, featureName: "AWS Infrastructure Provisioning & Governance" },
  { keywords: ["alert", "monitor", "observab", "dashboard", "synthetic", "new relic", "newrelic"], featureId: 485354, featureName: "Q3 - Observability & Alert Optimization" },
  { keywords: ["dfinedit", "decommission", "cleanup"], featureId: 485426, featureName: "Cleanup/Remove DFINEdits Resources" },
];

// Assignee patterns based on historical work areas
const ASSIGNEE_PATTERNS: { keywords: string[]; assignee: string }[] = [
  { keywords: ["pipeline", "orchestrator", "harness", "ci/cd", "build", "deploy_env", "artifact promot"], assignee: "Srinath Ekbote" },
  { keywords: ["gail v2", "gail environment", "gail service", "sonarqube"], assignee: "Srinath Ekbote" },
  { keywords: ["release cut", "prod release", "preprod upgrade", "predemo", "migration test"], assignee: "Krishnendu Sur" },
  { keywords: ["aks upgrade", "wiz", "delegate", "cve"], assignee: "Krishnendu Sur" },
  { keywords: ["alert", "monitor", "dashboard", "dpa", "newrelic", "scaling"], assignee: "Vanapilli Dinesh" },
  { keywords: ["runbook", "cert", "ssl", "db replica", "data classif", "audit"], assignee: "Hina Ayub" },
  { keywords: ["gail ci", "gail cd", "playwright", "ado feed"], assignee: "Shreya Chakole" },
  { keywords: ["aws", "inference profile", "bedrock", "dais", "terraform drift"], assignee: "Mohammad Rasheedi" },
];

export interface SuggestedDefaults {
  parentFeature?: { id: number; name: string; confidence: string };
  assignee?: { name: string; confidence: string; reason: string };
  productTag?: string;
  duplicates?: { id: number; title: string; similarity: string }[];
}

/**
 * Suggest parent feature based on title keywords.
 */
export function suggestParentFeature(title: string): { id: number; name: string; confidence: string } | undefined {
  const lowerTitle = title.toLowerCase();

  for (const { keywords, featureId, featureName } of FEATURE_KEYWORDS) {
    for (const kw of keywords) {
      if (lowerTitle.includes(kw.toLowerCase())) {
        return { id: featureId, name: featureName, confidence: "high" };
      }
    }
  }

  return undefined;
}

/**
 * Suggest assignee based on title keywords and historical patterns.
 */
export function suggestAssignee(title: string): { name: string; confidence: string; reason: string } | undefined {
  const lowerTitle = title.toLowerCase();

  for (const { keywords, assignee } of ASSIGNEE_PATTERNS) {
    for (const kw of keywords) {
      if (lowerTitle.includes(kw.toLowerCase())) {
        return { name: assignee, confidence: "medium", reason: `Historically handles "${kw}" work` };
      }
    }
  }

  return undefined;
}

/**
 * Suggest product tag based on title.
 */
export function suggestProductTag(title: string): string | undefined {
  const lower = title.toLowerCase();

  if (lower.includes("gail") || lower.includes("ai analysis") || lower.includes("inference") || lower.includes("bedrock")) {
    return "GAIL";
  }
  if (lower.includes("aws") || lower.includes("dais") || lower.includes("cloudwatch") || lower.includes("s3 bucket")) {
    return "AWS";
  }
  // Default to AD for most SRE work
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
  // Extract key words (3+ chars, not common words)
  const stopWords = ["the", "and", "for", "from", "with", "all", "new", "fix", "add", "create", "update"];
  const words = title
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.includes(w.toLowerCase()))
    .slice(0, 3);

  if (words.length === 0) return [];

  // Search for items with similar title words
  const searchTerms = words.map((w) => `[System.Title] CONTAINS '${w}'`).join(" AND ");
  const wiql = `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.AreaPath] UNDER 'SRE Operations and BAU\\Cloud Operations\\Ops\\Ensono - AD' AND [System.WorkItemType] = 'Engineering Story' AND ${searchTerms} AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`;

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

/**
 * Get all suggestions for a new work item.
 */
export async function getSuggestions(
  client: AdoClient,
  title: string,
  project?: string
): Promise<SuggestedDefaults> {
  const suggestions: SuggestedDefaults = {};

  suggestions.parentFeature = suggestParentFeature(title);
  suggestions.assignee = suggestAssignee(title);
  suggestions.productTag = suggestProductTag(title);

  const dupes = await findDuplicates(client, title, project);
  if (dupes.length > 0) {
    suggestions.duplicates = dupes.map((d) => ({
      id: d.id,
      title: d.title,
      similarity: "keyword match",
    }));
  }

  return suggestions;
}
