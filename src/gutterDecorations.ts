/**
 * Gutter decorations — coloured dots in the editor margin for each finding.
 */

import * as path from "path";
import * as vscode from "vscode";
import { CritiqComment, CritiqResult } from "./critiq";

// ── Decoration types (created once, reused across reviews) ──────────────────

// Overview ruler colours per severity
const RULER_COLOURS: Record<CritiqComment["severity"], string> = {
  critical: "rgba(244,71,71,0.8)",
  warning: "rgba(255,140,0,0.8)",
  info: "rgba(117,190,255,0.6)",
  suggestion: "rgba(138,138,138,0.5)",
};

function makeDecorationType(
  iconFile: string,
  rulerColor: string
): vscode.TextEditorDecorationType {
  const iconPath = path.join(__dirname, "..", "images", iconFile);
  return vscode.window.createTextEditorDecorationType({
    gutterIconPath: iconPath,
    gutterIconSize: "contain",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    overviewRulerColor: rulerColor,
  });
}

const DECORATION_TYPES: Record<
  CritiqComment["severity"],
  vscode.TextEditorDecorationType
> = {
  critical: makeDecorationType("gutter-critical.svg", RULER_COLOURS.critical),
  warning: makeDecorationType("gutter-warning.svg", RULER_COLOURS.warning),
  info: makeDecorationType("gutter-info.svg", RULER_COLOURS.info),
  suggestion: makeDecorationType("gutter-suggestion.svg", RULER_COLOURS.suggestion),
};

// ── Inline ghost text decoration (one shared type, per-range renderOptions) ──

const INLINE_GHOST_TYPE = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editorGhostText.foreground'),
    fontStyle: 'italic',
    margin: '0 0 0 1.5em',
  },
});

// ── Line number parsing ──────────────────────────────────────────────────────

function parseLineNumber(lineRef: string): number {
  if (!lineRef) return 0;
  const cleaned = lineRef.replace(/^[Ll]ine\s+/i, "").replace(/^L/i, "");
  const dashIdx = cleaned.indexOf("-");
  const numStr = dashIdx > 0 ? cleaned.slice(0, dashIdx) : cleaned;
  const n = parseInt(numStr, 10);
  return isNaN(n) ? 0 : Math.max(0, n - 1);
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class CritiqGutterDecorations {
  private _lastResult: CritiqResult | null = null;
  private _lastRoot = "";

  /**
   * Apply gutter decorations to all currently visible editors.
   * Stores result/root so applyToEditor() can use them later.
   */
  apply(result: CritiqResult, workspaceRoot: string): void {
    this._lastResult = result;
    this._lastRoot = workspaceRoot;
    // Group comments by absolute file path and by severity
    const byFileSeverity = new Map<
      string,
      Map<CritiqComment["severity"], number[]>
    >();

    for (const comment of result.comments) {
      if (!comment.file) continue;
      const absPath = comment.file.startsWith("/")
        ? comment.file
        : path.join(workspaceRoot, comment.file);

      if (!byFileSeverity.has(absPath)) {
        byFileSeverity.set(absPath, new Map());
      }
      const sevMap = byFileSeverity.get(absPath)!;
      if (!sevMap.has(comment.severity)) {
        sevMap.set(comment.severity, []);
      }
      sevMap.get(comment.severity)!.push(parseLineNumber(comment.line));
    }

    // Build per-file ghost text options (line → first title)
    const byFileGhost = new Map<string, Map<number, string>>();
    for (const comment of result.comments) {
      if (!comment.file) continue;
      const absPath = comment.file.startsWith("/")
        ? comment.file
        : path.join(workspaceRoot, comment.file);
      if (!byFileGhost.has(absPath)) byFileGhost.set(absPath, new Map());
      const lineNum = parseLineNumber(comment.line);
      // Only show the first issue on each line (most severe first → keep existing)
      if (!byFileGhost.get(absPath)!.has(lineNum)) {
        const prefix = comment.severity === "critical" ? "⚡" : comment.severity === "warning" ? "⚠" : "·";
        byFileGhost.get(absPath)!.set(lineNum, `  ${prefix} ${comment.title}`);
      }
    }

    // For each open editor that has findings, apply decorations
    for (const editor of vscode.window.visibleTextEditors) {
      const filePath = editor.document.uri.fsPath;
      const sevMap = byFileSeverity.get(filePath);

      // Clear all decoration types for this editor first
      for (const decType of Object.values(DECORATION_TYPES)) {
        editor.setDecorations(decType, []);
      }
      editor.setDecorations(INLINE_GHOST_TYPE, []);

      if (!sevMap) continue;

      for (const [severity, lines] of sevMap) {
        const decType = DECORATION_TYPES[severity];
        const ranges = lines.map(
          (line) => new vscode.Range(line, 0, line, 0)
        );
        editor.setDecorations(decType, ranges);
      }

      // Apply inline ghost text
      const ghostMap = byFileGhost.get(filePath);
      if (ghostMap) {
        const ghostDecorations: vscode.DecorationOptions[] = [];
        for (const [line, text] of ghostMap) {
          ghostDecorations.push({
            range: new vscode.Range(line, 999, line, 999),
            renderOptions: { after: { contentText: text } },
          });
        }
        editor.setDecorations(INLINE_GHOST_TYPE, ghostDecorations);
      }
    }
  }

  /** Clear all decorations from all visible editors. */
  clear(): void {
    this._lastResult = null;
    this._lastRoot = "";
    for (const editor of vscode.window.visibleTextEditors) {
      for (const decType of Object.values(DECORATION_TYPES)) {
        editor.setDecorations(decType, []);
      }
    }
  }

  /**
   * Re-apply decorations for a newly opened/visible editor.
   * Uses the last stored result — call this from onDidChangeActiveTextEditor.
   */
  applyToEditor(editor: vscode.TextEditor): void {
    if (!this._lastResult) return;

    const result = this._lastResult;
    const workspaceRoot = this._lastRoot;
    const filePath = editor.document.uri.fsPath;

    const comments = result.comments.filter((c) => {
      if (!c.file) return false;
      const abs = c.file.startsWith("/")
        ? c.file
        : path.join(workspaceRoot, c.file);
      return abs === filePath;
    });

    // Clear first
    for (const decType of Object.values(DECORATION_TYPES)) {
      editor.setDecorations(decType, []);
    }

    // Group by severity and apply
    const bySeverity = new Map<CritiqComment["severity"], number[]>();
    for (const comment of comments) {
      if (!bySeverity.has(comment.severity)) {
        bySeverity.set(comment.severity, []);
      }
      bySeverity.get(comment.severity)!.push(parseLineNumber(comment.line));
    }

    for (const [severity, lines] of bySeverity) {
      const decType = DECORATION_TYPES[severity];
      const ranges = lines.map((line) => new vscode.Range(line, 0, line, 0));
      editor.setDecorations(decType, ranges);
    }
  }

  dispose(): void {
    for (const decType of Object.values(DECORATION_TYPES)) {
      decType.dispose();
    }
  }
}
