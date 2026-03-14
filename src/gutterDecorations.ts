/**
 * critiq Gutter Decorations — colored icons in the editor gutter and
 * inline ghost-text hints at end of problematic lines (GitLens-style).
 *
 * Visual language:
 *   🔴 Critical  → red circle   + red overview ruler dot
 *   🟡 Warning   → yellow circle + yellow overview ruler dot
 *   🔵 Info      → blue circle  + blue overview ruler dot
 *   💡 Suggestion → gray circle  + gray overview ruler dot
 *
 * Inline hint (after each line):
 *   "  ⚡ SQL injection vulnerability"  (italic, faded)
 */

import * as path from "path";
import * as vscode from "vscode";
import { CritiqComment, CritiqResult } from "./critiq";

// ── SVG data URIs for gutter icons ───────────────────────────────────────────

function circleSvg(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="${color}" opacity="0.9"/></svg>`;
  return vscode.Uri.parse(
    `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  );
}

// ── Decoration types (created once, disposed on deactivate) ──────────────────

function makeDecorationType(
  gutterColor: string,
  overviewColor: string,
  inlineColor: string
): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    gutterIconPath: circleSvg(gutterColor),
    gutterIconSize: "contain",
    overviewRulerColor: overviewColor,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    // Inline ghost-text is handled per-decoration (options property)
    // so we keep the type plain and attach contentText via DecorationOptions
  });
}

// Severity-keyed decoration types
const DECORATION_TYPES: Record<
  CritiqComment["severity"],
  vscode.TextEditorDecorationType
> = {
  critical: makeDecorationType("#f44747", "#f44747cc", "#f4474799"),
  warning: makeDecorationType("#e5c07b", "#e5c07bcc", "#e5c07b99"),
  info: makeDecorationType("#61afef", "#61afefcc", "#61afef99"),
  suggestion: makeDecorationType("#abb2bf", "#abb2bfcc", "#abb2bf99"),
};

// Icon prefix for inline hint per severity
const INLINE_ICON: Record<CritiqComment["severity"], string> = {
  critical: "⚡",
  warning: "⚠",
  info: "ℹ",
  suggestion: "💡",
};

// ── Line number parser (shared util) ─────────────────────────────────────────

function parseLineNumber(lineRef: string | undefined): number | null {
  if (!lineRef) {
    return null;
  }
  const cleaned = lineRef
    .replace(/^[Ll]ine\s+/i, "")
    .replace(/^[Ll]/i, "");
  const dashIdx = cleaned.indexOf("-");
  const numStr = dashIdx > 0 ? cleaned.slice(0, dashIdx) : cleaned;
  const n = parseInt(numStr, 10);
  return isNaN(n) ? null : Math.max(0, n - 1);
}

// ── Main class ────────────────────────────────────────────────────────────────

export class CritiqGutterDecorations {
  /** Map: absolute file path → list of comments with resolved lines */
  private byFile = new Map<
    string,
    Array<{ line: number; comment: CritiqComment }>
  >();

  private workspaceRoot = "";

  // ── Public API ─────────────────────────────────────────────────────────────

  update(result: CritiqResult, workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;

    // Rebuild per-file map
    const newMap = new Map<string, Array<{ line: number; comment: CritiqComment }>>();
    for (const comment of result.comments) {
      if (!comment.file) {
        continue;
      }
      const lineNum = parseLineNumber(comment.line);
      if (lineNum === null) {
        continue;
      }
      const absPath = comment.file.startsWith("/")
        ? comment.file
        : path.join(workspaceRoot, comment.file);
      const existing = newMap.get(absPath) ?? [];
      newMap.set(absPath, [...existing, { line: lineNum, comment }]);
    }
    this.byFile = newMap;

    // Apply to all currently open editors
    for (const editor of vscode.window.visibleTextEditors) {
      this._applyToEditor(editor);
    }
  }

  clear(): void {
    this.byFile = new Map();
    for (const editor of vscode.window.visibleTextEditors) {
      this._clearEditor(editor);
    }
  }

  /** Call when the active editor changes or a new editor opens. */
  applyToEditor(editor: vscode.TextEditor): void {
    this._applyToEditor(editor);
  }

  dispose(): void {
    for (const dt of Object.values(DECORATION_TYPES)) {
      dt.dispose();
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _clearEditor(editor: vscode.TextEditor): void {
    for (const dt of Object.values(DECORATION_TYPES)) {
      editor.setDecorations(dt, []);
    }
  }

  private _applyToEditor(editor: vscode.TextEditor): void {
    const filePath = editor.document.uri.fsPath;
    const entries = this.byFile.get(filePath);

    if (!entries || entries.length === 0) {
      this._clearEditor(editor);
      return;
    }

    // Group by severity
    const grouped: Record<
      CritiqComment["severity"],
      vscode.DecorationOptions[]
    > = {
      critical: [],
      warning: [],
      info: [],
      suggestion: [],
    };

    for (const { line, comment } of entries) {
      const safeLineNum = Math.min(line, editor.document.lineCount - 1);
      const lineText = editor.document.lineAt(safeLineNum).text;
      const range = new vscode.Range(
        safeLineNum,
        0,
        safeLineNum,
        lineText.length
      );

      const icon = INLINE_ICON[comment.severity];
      const hintText = comment.title.length > 60
        ? comment.title.slice(0, 57) + "…"
        : comment.title;

      const decoration: vscode.DecorationOptions = {
        range,
        // Inline ghost-text shown after line content
        renderOptions: {
          after: {
            contentText: `  ${icon} ${hintText}`,
            color: new vscode.ThemeColor(
              comment.severity === "critical"
                ? "editorError.foreground"
                : comment.severity === "warning"
                ? "editorWarning.foreground"
                : "editorInfo.foreground"
            ),
            fontStyle: "italic",
            margin: "0 0 0 1em",
          },
        },
        hoverMessage: new vscode.MarkdownString(
          buildHoverMarkdown(comment)
        ),
      };

      grouped[comment.severity].push(decoration);
    }

    // Apply each severity group
    for (const [severity, decorations] of Object.entries(grouped)) {
      const dt = DECORATION_TYPES[severity as CritiqComment["severity"]];
      editor.setDecorations(dt, decorations);
    }
  }
}

// ── Hover markdown builder ────────────────────────────────────────────────────

function buildHoverMarkdown(comment: CritiqComment): string {
  const severityBadge: Record<CritiqComment["severity"], string> = {
    critical: "$(error) **CRITICAL**",
    warning: "$(warning) **WARNING**",
    info: "$(info) **INFO**",
    suggestion: "$(lightbulb) **SUGGESTION**",
  };

  const lines: string[] = [
    `${severityBadge[comment.severity]} — ${comment.title}`,
    "",
  ];

  if (comment.body) {
    lines.push(comment.body);
    lines.push("");
  }

  if (comment.category) {
    lines.push(`*Category: ${comment.category}*`);
  }

  if (comment.file && comment.line) {
    lines.push(`*${comment.file} ${comment.line}*`);
  }

  lines.push("---");
  lines.push("$(wand) Run **critiq: Fix All Issues** to auto-fix");

  return lines.join("\n");
}
