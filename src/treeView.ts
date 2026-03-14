/**
 * Tree view panel — shows all critiq findings organized by severity group,
 * then by file. Clicking a finding navigates to that file:line.
 */

import * as path from "path";
import * as vscode from "vscode";
import { CritiqComment, CritiqResult } from "./critiq";

// ── Tree node types ───────────────────────────────────────────────────────────

type NodeKind = "group" | "file" | "finding";

interface GroupNode {
  kind: "group";
  severity: CritiqComment["severity"];
  label: string;
  count: number;
  children: FileNode[];
}

interface FileNode {
  kind: "file";
  label: string;
  absPath: string;
  severity: CritiqComment["severity"];
  children: FindingNode[];
}

interface FindingNode {
  kind: "finding";
  comment: CritiqComment;
  absPath: string;
  lineNum: number; // 0-based
}

type TreeNode = GroupNode | FileNode | FindingNode;

// ── Helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: CritiqComment["severity"][] = [
  "critical",
  "warning",
  "info",
  "suggestion",
];

const SEVERITY_ICONS: Record<CritiqComment["severity"], string> = {
  critical: "$(error)",
  warning: "$(warning)",
  info: "$(info)",
  suggestion: "$(lightbulb)",
};

const SEVERITY_LABELS: Record<CritiqComment["severity"], string> = {
  critical: "Critical",
  warning: "Warnings",
  info: "Info",
  suggestion: "Suggestions",
};

function parseLineNumber(lineRef: string): number {
  if (!lineRef) return 0;
  const cleaned = lineRef.replace(/^[Ll]ine\s+/i, "").replace(/^L/i, "");
  const dashIdx = cleaned.indexOf("-");
  const numStr = dashIdx > 0 ? cleaned.slice(0, dashIdx) : cleaned;
  const n = parseInt(numStr, 10);
  return isNaN(n) ? 0 : Math.max(0, n - 1);
}

function buildTree(
  result: CritiqResult,
  workspaceRoot: string
): GroupNode[] {
  // Group by severity → file → findings
  const grouped = new Map<
    CritiqComment["severity"],
    Map<string, { absPath: string; comments: CritiqComment[] }>
  >();

  for (const sev of SEVERITY_ORDER) {
    grouped.set(sev, new Map());
  }

  for (const comment of result.comments) {
    const sev = comment.severity;
    const fileMap = grouped.get(sev)!;

    const absPath = comment.file
      ? comment.file.startsWith("/")
        ? comment.file
        : path.join(workspaceRoot, comment.file)
      : workspaceRoot;

    const key = absPath;
    if (!fileMap.has(key)) {
      fileMap.set(key, { absPath, comments: [] });
    }
    fileMap.get(key)!.comments.push(comment);
  }

  const groups: GroupNode[] = [];

  for (const sev of SEVERITY_ORDER) {
    const fileMap = grouped.get(sev)!;
    if (fileMap.size === 0) continue;

    const fileNodes: FileNode[] = [];
    for (const { absPath, comments } of fileMap.values()) {
      const findings: FindingNode[] = comments.map((c) => ({
        kind: "finding" as const,
        comment: c,
        absPath,
        lineNum: parseLineNumber(c.line),
      }));
      fileNodes.push({
        kind: "file",
        label: path.basename(absPath),
        absPath,
        severity: sev,
        children: findings,
      });
    }

    const totalFindings = fileNodes.reduce((s, f) => s + f.children.length, 0);
    groups.push({
      kind: "group",
      severity: sev,
      label: `${SEVERITY_LABELS[sev]} (${totalFindings})`,
      count: totalFindings,
      children: fileNodes,
    });
  }

  return groups;
}

// ── TreeDataProvider ──────────────────────────────────────────────────────────

export class CritiqTreeProvider
  implements vscode.TreeDataProvider<TreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _groups: GroupNode[] = [];
  private _summary = "";

  update(result: CritiqResult | null, workspaceRoot: string): void {
    if (!result) {
      this._groups = [];
      this._summary = "";
    } else {
      this._groups = buildTree(result, workspaceRoot);
      this._summary = result.summary;
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        `${SEVERITY_ICONS[node.severity]} ${node.label}`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.contextValue = "critiqGroup";
      return item;
    }

    if (node.kind === "file") {
      const item = new vscode.TreeItem(
        `$(file-code) ${node.label}`,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = `${node.children.length} issue${node.children.length !== 1 ? "s" : ""}`;
      item.tooltip = node.absPath;
      item.contextValue = "critiqFile";
      item.command = {
        command: "vscode.open",
        title: "Open file",
        arguments: [vscode.Uri.file(node.absPath)],
      };
      return item;
    }

    // finding node
    const { comment, absPath, lineNum } = node;
    const icon = SEVERITY_ICONS[comment.severity];
    const lineDisplay = comment.line ? ` (${comment.line})` : "";
    const item = new vscode.TreeItem(
      `${icon} ${comment.title}${lineDisplay}`,
      vscode.TreeItemCollapsibleState.None
    );

    // Trim body for tooltip
    const bodyShort = comment.body
      .replace(/\*\*/g, "")
      .split("\n")
      .slice(0, 3)
      .join("\n");
    item.tooltip = new vscode.MarkdownString(
      `**${comment.severity.toUpperCase()}**: ${comment.title}\n\n${bodyShort}`
    );
    item.description = comment.category || undefined;
    item.contextValue = "critiqFinding";

    // Navigate to the finding on click
    item.command = {
      command: "vscode.open",
      title: "Go to finding",
      arguments: [
        vscode.Uri.file(absPath),
        {
          selection: new vscode.Range(lineNum, 0, lineNum, 0),
        } as vscode.TextDocumentShowOptions,
      ],
    };

    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      // Root — return groups, or a placeholder if empty
      if (this._groups.length === 0) {
        return [];
      }
      return this._groups;
    }
    if (node.kind === "group") return node.children;
    if (node.kind === "file") return node.children;
    return [];
  }
}
