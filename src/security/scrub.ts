/**
 * Prompt-Injection Defence & Input Sanitization
 * - Scans tool responses for malicious patterns before they reach the LLM.
 * - Provides WIQL input escaping to prevent query injection.
 */

/**
 * Escape a value for safe interpolation into a WIQL string literal.
 * Doubles single quotes to prevent breaking out of WIQL string context.
 */
export function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Validate that a WIQL query is a read-only SELECT statement.
 */
export function validateWiqlSelect(wiql: string): boolean {
  return /^\s*(SELECT|WITH)\b/i.test(wiql.trim());
}

const INJECTION_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, name: "instruction_override" },
  { pattern: /ignore\s+(all\s+)?above\s+instructions/i, name: "instruction_override" },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above)/i, name: "instruction_override" },
  { pattern: /you\s+are\s+now\s+a/i, name: "role_hijack" },
  { pattern: /new\s+system\s+prompt/i, name: "system_prompt_override" },
  { pattern: /system:\s*you\s+are/i, name: "system_prompt_override" },
  { pattern: /<script[\s>]/i, name: "html_injection" },
  { pattern: /<iframe[\s>]/i, name: "html_injection" },
  { pattern: /javascript:/i, name: "html_injection" },
  { pattern: /on(error|load|click)\s*=/i, name: "html_injection" },
  { pattern: /\[system\]/i, name: "system_tag_injection" },
  { pattern: /\[INST\]/i, name: "instruction_tag_injection" },
  { pattern: /<<\s*SYS\s*>>/i, name: "system_tag_injection" },
  { pattern: /\bhuman:\s/i, name: "role_injection" },
  { pattern: /\bassistant:\s/i, name: "role_injection" },
];

export interface ScrubResult {
  text: string;
  wasModified: boolean;
  detections: string[];
}

/**
 * Scrub a tool response string for prompt injection patterns.
 * Returns the sanitized text and any detections found.
 */
export function scrubToolResponse(input: string): ScrubResult {
  const detections: string[] = [];

  let scrubbed = input;
  for (const { pattern, name } of INJECTION_PATTERNS) {
    if (pattern.test(scrubbed)) {
      detections.push(name);
      // Use global flag to replace ALL occurrences, not just the first
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      scrubbed = scrubbed.replace(globalPattern, "[REDACTED: potential injection detected]");
    }
  }

  return {
    text: scrubbed,
    wasModified: detections.length > 0,
    detections,
  };
}

/**
 * Scrub all text content in an MCP tool result.
 */
export function scrubMcpContent(
  content: { type: string; text?: string }[]
): { content: { type: string; text?: string }[]; detections: string[] } {
  const allDetections: string[] = [];

  const scrubbedContent = content.map((item) => {
    if (item.type === "text" && item.text) {
      const result = scrubToolResponse(item.text);
      if (result.wasModified) {
        allDetections.push(...result.detections);
      }
      return { ...item, text: result.text };
    }
    return item;
  });

  return { content: scrubbedContent, detections: allDetections };
}
