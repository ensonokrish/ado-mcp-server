/**
 * Prompt-Injection Defence
 * Scans tool responses for malicious patterns before they reach the LLM.
 * Patterns like "ignore all previous instructions", HTML injection,
 * and system prompt overrides are detected and replaced with safe redaction.
 */

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
      scrubbed = scrubbed.replace(pattern, "[REDACTED: potential injection detected]");
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
