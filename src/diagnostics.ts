/**
 * Converts critiq findings into VS Code Diagnostics (Problems panel).
 */

import * as vscode from "vscode";
import { CritiqComment, CritiqResult } from "./critiq";

// ── Severity mapping ─────────────────────────────────────────────────────────

function toDiagnosticSeverity(
  severity: CritiqComment["severity"]
): vscode.DiagnosticSeverity {
  switch (severity) {
    case "critical":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "info":
      return vscode.DiagnosticSeverity.Information;
    case "suggestion":
      return vscode.DiagnosticSeverity.Hint;
  }
}

// ── Line number parsing ──────────────────────────────────────────────────────

/**
 * Parse "L42" → 41 (0-based), "L42-50" → 41, "" → 0.
 */
function parseLineNumber(lineRef: string): number {
  if (!lineRef) {
    return 0;
  }
  // Strip leading "L" or "line "
  const cleaned = lineRef.replace(/^[Ll]ine\s+/i, "").replace(/^L/i, "");
  // Handle ranges like "42-50"
  const dashIdx = cleaned.indexOf("-");
  const numStr = dashIdx > 0 ? cleaned.slice(0, dashIdx) : cleaned;
  const n = parseInt(numStr, 10);
  return isNaN(n) ? 0 : Math.max(0, n - 1); // convert to 0-based
}

// ── Diagnostic collection builder ────────────────────────────────────────────

export function buildDiagnostics(
  result: CritiqResult,
  workspaceRoot: string
): Map<string, vscode.Diagnostic[]> {
  const byFile = new Map<string, vscode.Diagnostic[]>();

  for (const comment of result.comments) {
    if (!comment.file) {
      continue;
    }

    const absPath = comment.file.startsWith("/")
      ? comment.file
      : `${workspaceRoot}/${comment.file}`;

    const lineNum = parseLineNumber(comment.line);
    const range = new vscode.Range(lineNum, 0, lineNum, 999);

    // Build message: title + body summary
    const bodyOneLine = comment.body
      .replace(/\*\*/g, "")
      .replace(/\n/g, " · ")
      .trim();
    const message = bodyOneLine
      ? `[${comment.severity.toUpperCase()}] ${comment.title} · ${bodyOneLine}`
      : `[${comment.severity.toUpperCase()}] ${comment.title}`;

    const diag = new vscode.Diagnostic(
      range,
      message,
      toDiagnosticSeverity(comment.severity)
    );
    diag.source = "critiq";
    diag.code = comment.category || undefined;

    const existing = byFile.get(absPath) ?? [];
    byFile.set(absPath, [...existing, diag]);
  }

  return byFile;
}

// ── DiagnosticCollection manager ─────────────────────────────────────────────

export class CritiqDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection("critiq");
  }

  apply(result: CritiqResult, workspaceRoot: string): void {
    this.collection.clear();

    const byFile = buildDiagnostics(result, workspaceRoot);
    for (const [filePath, diags] of byFile) {
      const uri = vscode.Uri.file(filePath);
      this.collection.set(uri, diags);
    }
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
