/**
 * Full Audit Trail
 * Logs every tool invocation with timestamp, tool name, redacted arguments,
 * success/failure, and execution time. 10 MB x 10 rotation files.
 */

import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = "audit.log";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 10;

// Sensitive fields to redact in arguments
const SENSITIVE_FIELDS = ["pat", "token", "password", "secret", "api_key"];

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogPath(index: number = 0): string {
  return path.join(LOG_DIR, index === 0 ? LOG_FILE : `audit.${index}.log`);
}

function rotateIfNeeded(): void {
  const currentLog = getLogPath();
  if (!fs.existsSync(currentLog)) return;

  const stats = fs.statSync(currentLog);
  if (stats.size < MAX_FILE_SIZE) return;

  // Rotate: delete oldest, shift others
  const oldest = getLogPath(MAX_FILES - 1);
  if (fs.existsSync(oldest)) {
    fs.unlinkSync(oldest);
  }

  for (let i = MAX_FILES - 2; i >= 0; i--) {
    const from = getLogPath(i);
    const to = getLogPath(i + 1);
    if (fs.existsSync(from)) {
      fs.renameSync(from, to);
    }
  }
}

/**
 * Redact sensitive values from arguments object.
 */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_FIELDS.includes(key.toLowerCase())) {
      const strVal = String(value);
      redacted[key] = strVal.length > 4
        ? `****${strVal.slice(-4)}`
        : "****";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  arguments: Record<string, unknown>;
  success: boolean;
  error?: string;
  durationMs: number;
  detections?: string[];
}

/**
 * Log an audit entry to the audit log file.
 */
export function logAudit(entry: AuditEntry): void {
  try {
    ensureLogDir();
    rotateIfNeeded();

    const logLine = JSON.stringify({
      ...entry,
      arguments: redactArgs(entry.arguments),
    }) + "\n";

    fs.appendFileSync(getLogPath(), logLine);
  } catch {
    // Audit logging should never break the tool
  }
}

/**
 * Create an audit wrapper that times and logs a tool execution.
 */
export function auditTool(
  toolName: string,
  args: Record<string, unknown>,
  fn: () => Promise<{ content: { type: string; text?: string }[] }>
): Promise<{ content: { type: string; text?: string }[]; startTime: number }> {
  const startTime = Date.now();

  return fn()
    .then((result) => {
      logAudit({
        timestamp: new Date().toISOString(),
        tool: toolName,
        arguments: args,
        success: true,
        durationMs: Date.now() - startTime,
      });
      return { ...result, startTime };
    })
    .catch((err) => {
      logAudit({
        timestamp: new Date().toISOString(),
        tool: toolName,
        arguments: args,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      });
      throw err;
    });
}
