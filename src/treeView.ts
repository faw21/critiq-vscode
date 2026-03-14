/**
 * critiq Tree View — shows findings organized by file in the Explorer/Activity Bar.
 *
 * Structure:
 *   📁 src/auth.py (3 issues)
 *     🚨 [CRITICAL] SQL Injection vulnerability   L42
 *     ⚠️  [WARNING]  Bare except clause            L58
 *     💡 [SUGGESTION] Missing type annotation     L71
 *   📁 src/utils.py (1 issue)
 *     ⚠️  [WARNING]  MD5 used for password hash   L12
 */

import * as path from "path";
import * as vscode from "vscode";
import { CritiqComment, CritiqResult } from "./critiq";

// ── Tree item types ───────────────────────────────────────────────────────────

export class FileNode extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly issues: CritiqComment[]
  ) {
    const label = path.basename(filePath);
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
    this.tooltip = filePath;
    this.contextValue = "critiqFile";
    this.iconPath = new vscode.ThemeIcon("file-code");
  }
}

export class IssueNode extends vscode.TreeItem {
  constructor(
    public readonly comment: CritiqComment,
    public readonly workspaceRoot: string
  ) {
    const icon = severityIcon(comment.severity);
    super(`${icon} ${comment.title}`, vscode.TreeItemCollapsibleState.None);

    this.description = comment.line || "";
    this.tooltip = comment.body || comment.title;
    this.contextValue = "critiqIssue";

    // Click → navigate to the file at the issue line
    if (comment.file) {
      const absPath = comment.file.startsWith("/")
        ? comment.file
        : path.join(workspaceRoot, comment.file);
      const lineNum = parseLineNumber(comment.line);

      this.command = {
        command: "critiq.openIssue",
        title: "Go to issue",
        arguments: [absPath, lineNum],
      };
    }

    // Use diagnostic severity colour
    this.iconPath = severityThemeIcon(comment.severity);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function severityIcon(severity: CritiqComment["severity"]): string {
  switch (severity) {
    case "critical":
      return "🚨";
    case "warning":
      return "⚠️ ";
    case "info":
      return "ℹ️ ";
    case "suggestion":
      return "💡";
  }
}

function severityThemeIcon(
  severity: CritiqComment["severity"]
): vscode.ThemeIcon {
  switch (severity) {
    case "critical":
      return new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("errorForeground")
      );
    case "warning":
      return new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("editorWarning.foreground")
      );
    case "info":
      return new vscode.ThemeIcon(
        "info",
        new vscode.ThemeColor("editorInfo.foreground")
      );
    case "suggestion":
      return new vscode.ThemeIcon("lightbulb");
  }
}

function parseLineNumber(lineRef: string): number {
  if (!lineRef) {
    return 0;
  }
  const cleaned = lineRef.replace(/^[Ll]ine\s+/i, "").replace(/^L/i, "");
  const dashIdx = cleaned.indexOf("-");
  const numStr = dashIdx > 0 ? cleaned.slice(0, dashIdx) : cleaned;
  const n = parseInt(numStr, 10);
  return isNaN(n) ? 0 : Math.max(0, n - 1);
}

type TreeNode = FileNode | IssueNode;

// ── Tree data provider ────────────────────────────────────────────────────────

export class CritiqTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private result: CritiqResult | null = null;
  private workspaceRoot = "";

  update(result: CritiqResult, workspaceRoot: string): void {
    this.result = result;
    this.workspaceRoot = workspaceRoot;
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.result = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!this.result) {
      return [];
    }

    // Root level → group by file
    if (!element) {
      return this._buildFileNodes();
    }

    // File level → show issues
    if (element instanceof FileNode) {
      return element.issues.map(
        (c) => new IssueNode(c, this.workspaceRoot)
      );
    }

    return [];
  }

  private _buildFileNodes(): FileNode[] {
    if (!this.result) {
      return [];
    }

    const byFile = new Map<string, CritiqComment[]>();

    for (const comment of this.result.comments) {
      const fileKey = comment.file || "(no file)";
      const existing = byFile.get(fileKey) ?? [];
      byFile.set(fileKey, [...existing, comment]);
    }

    // Sort: most severe first (files with critical issues at top)
    const sorted = [...byFile.entries()].sort(([, a], [, b]) => {
      const score = (comments: CritiqComment[]) =>
        comments.reduce((s, c) => {
          return (
            s +
            (c.severity === "critical"
              ? 1000
              : c.severity === "warning"
              ? 100
              : c.severity === "info"
              ? 10
              : 1)
          );
        }, 0);
      return score(b) - score(a);
    });

    return sorted.map(([filePath, issues]) => {
      const absPath = filePath.startsWith("/")
        ? filePath
        : path.join(this.workspaceRoot, filePath);
      return new FileNode(absPath, issues);
    });
  }
}
