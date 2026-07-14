/**
 * Spell-check utility for work item titles and descriptions.
 * Contains common SRE/DevOps/DFIN-specific corrections.
 */

// Common misspellings found in historical ADO data
const CORRECTIONS: [RegExp, string][] = [
  [/\brelese\b/gi, "release"],
  [/\brelase\b/gi, "release"],
  [/\brelece\b/gi, "release"],
  [/\bcomsuming\b/gi, "consuming"],
  [/\bconsuimg\b/gi, "consuming"],
  [/\benviroment\b/gi, "environment"],
  [/\benvirnoment\b/gi, "environment"],
  [/\bdeplyment\b/gi, "deployment"],
  [/\bdeployement\b/gi, "deployment"],
  [/\bpipline\b/gi, "pipeline"],
  [/\bpiepline\b/gi, "pipeline"],
  [/\bpipleline\b/gi, "pipeline"],
  [/\borchestator\b/gi, "orchestrator"],
  [/\borchestrater\b/gi, "orchestrator"],
  [/\binfrastucture\b/gi, "infrastructure"],
  [/\binfrasturcture\b/gi, "infrastructure"],
  [/\bremidiation\b/gi, "remediation"],
  [/\bremedation\b/gi, "remediation"],
  [/\bmoniterring\b/gi, "monitoring"],
  [/\bmonitering\b/gi, "monitoring"],
  [/\bmonitorig\b/gi, "monitoring"],
  [/\bconfigration\b/gi, "configuration"],
  [/\bconfiguraion\b/gi, "configuration"],
  [/\bauthentiction\b/gi, "authentication"],
  [/\bauthentiation\b/gi, "authentication"],
  [/\bcertifcate\b/gi, "certificate"],
  [/\bcertifiate\b/gi, "certificate"],
  [/\bupgarde\b/gi, "upgrade"],
  [/\bupgarade\b/gi, "upgrade"],
  [/\bmigiration\b/gi, "migration"],
  [/\bmigraiton\b/gi, "migration"],
  [/\bvalidaton\b/gi, "validation"],
  [/\bvalidaion\b/gi, "validation"],
  [/\bexecueter\b/gi, "executer"],
  [/\bexecutor\b/gi, "executor"],
  [/\bingettion\b/gi, "ingestion"],
  [/\bingesion\b/gi, "ingestion"],
  [/\bprovisoning\b/gi, "provisioning"],
  [/\bprovisioing\b/gi, "provisioning"],
  [/\bdecomission\b/gi, "decommission"],
  [/\bdecommision\b/gi, "decommission"],
  [/\brunbok\b/gi, "runbook"],
  [/\brunbbok\b/gi, "runbook"],
  [/\bnotificaton\b/gi, "notification"],
  [/\bnotifcation\b/gi, "notification"],
  [/\breciever\b/gi, "receiver"],
  [/\breciver\b/gi, "receiver"],
  [/\bconnectivty\b/gi, "connectivity"],
  [/\bconectivity\b/gi, "connectivity"],
  [/\bfailuer\b/gi, "failure"],
  [/\bfailre\b/gi, "failure"],
  [/\bsythetic\b/gi, "synthetic"],
  [/\bsythentic\b/gi, "synthetic"],
  [/\bsynethtic\b/gi, "synthetic"],
];

export interface SpellCheckResult {
  original: string;
  corrected: string;
  corrections: { from: string; to: string }[];
}

/**
 * Check and correct common misspellings in text.
 */
export function spellCheck(text: string): SpellCheckResult {
  const corrections: { from: string; to: string }[] = [];
  let corrected = text;

  for (const [pattern, replacement] of CORRECTIONS) {
    const match = corrected.match(pattern);
    if (match) {
      corrections.push({ from: match[0], to: replacement });
      corrected = corrected.replace(pattern, replacement);
    }
  }

  return { original: text, corrected, corrections };
}
