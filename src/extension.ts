/**
 * critiq VS Code extension — entry point (v1.1.0).
 *
 * New in v1.1.0:
 *   - Gutter decorations (coloured dots in the editor margin)
 *   - Quick Fix code actions (Fix with critiq / Ignore pattern)
 *   - Tree view panel (critiq Findings in the sidebar)
 *
 * Commands:
 *   critiq.reviewStaged      — review staged git changes (Cmd+Shift+R)
 *   critiq.reviewBranch      — review all changes vs a branch
 *   critiq.reviewFile        — review current open file's changes
 *   critiq.clearDiagnostics  — clear all critiq diagnostics
 *   critiq.fixCurrentFile    — auto-fix issues in the current file
 *   critiq.learnIgnore       — ignore a pattern via critiq-learn
 *   critiq.showOutput        — focus the critiq Output channel
 */

import * as vscode from "vscode";
import { CritiqResult, ReviewMode, runCritiq } from "./critiq";
import { CritiqDiagnostics } from "./diagnostics";
import { CritiqGutterDecorations } from "./gutterDecorations";
import { CritiqStatusBar } from "./statusBar";
import { clearReviewState, onReviewStateChange, setReviewState } from "./reviewState";
import { CritiqCodeActionProvider, fixCurrentFile, learnIgnorePattern } from "./codeActions";
import { CritiqTreeProvider } from "./treeView";

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}

function summariseResult(result: CritiqResult): string {
  const critical = result.comments.filter((c) => c.severity === "critical").length;
  const warnings = result.comments.filter((c) => c.severity === "warning").length;
  const info = result.comments.filter(
    (c) => c.severity === "info" || c.severity === "suggestion"
  ).length;

  if (result.comments.length === 0) {
    return `✅ No issues found. ${result.summary}`;
  }

  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warnings > 0) parts.push(`${warnings} warnings`);
  if (info > 0) parts.push(`${info} suggestions`);
  return `${result.overall_rating}  ${parts.join(", ")}`;
}

// ── Core review runner ───────────────────────────────────────────────────────

async function runReview(
  mode: ReviewMode,
  diagnostics: CritiqDiagnostics,
  gutterDecorations: CritiqGutterDecorations,
  statusBar: CritiqStatusBar,
  treeProvider: CritiqTreeProvider,
  outputChannel: vscode.OutputChannel
): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    vscode.window.showErrorMessage(
      "critiq: No workspace folder open. Open a folder with a git repository."
    );
    return;
  }

  statusBar.setRunning();
  outputChannel.appendLine(
    `\n[critiq] Running review (${mode.kind})… ${new Date().toLocaleTimeString()}`
  );

  try {
    const result = await runCritiq(root, mode);

    // Update shared review state
    const branch = mode.kind === "branch" ? mode.branch : undefined;
    setReviewState(result, root, mode.kind, branch);

    // Apply all UI components
    diagnostics.apply(result, root);
    gutterDecorations.apply(result, root);
    statusBar.setResult(result);
    treeProvider.update(result, root);

    const summary = summariseResult(result);
    outputChannel.appendLine(`[critiq] ${summary}`);

    if (result.summary) {
      outputChannel.appendLine(`         ${result.summary}`);
    }

    if (result.comments.length > 0) {
      outputChannel.appendLine("");
      for (const c of result.comments) {
        const icon =
          c.severity === "critical" ? "🚨"
          : c.severity === "warning" ? "⚠️ "
          : c.severity === "info" ? "ℹ️ "
          : "💡";
        outputChannel.appendLine(
          `  ${icon} [${c.severity.toUpperCase()}] ${c.title}`
        );
        if (c.file) {
          outputChannel.appendLine(`     ${c.file} ${c.line}`);
        }
        if (c.body) {
          const bodyShort = c.body.replace(/\*\*/g, "").split("\n")[0];
          outputChannel.appendLine(`     ${bodyShort}`);
        }
      }
    }

    // Notify for critical issues
    const critical = result.comments.filter((c) => c.severity === "critical").length;
    if (critical > 0) {
      const action = await vscode.window.showWarningMessage(
        `critiq found ${critical} critical issue(s)`,
        "Show Problems",
        "Fix All",
        "Dismiss"
      );
      if (action === "Show Problems") {
        vscode.commands.executeCommand("workbench.action.problems.focus");
      } else if (action === "Fix All") {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          vscode.commands.executeCommand("critiq.fixCurrentFile", editor.document.uri);
        }
      }
    } else if (result.comments.length === 0) {
      vscode.window.showInformationMessage("critiq: ✅ No issues found.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[critiq] Error: ${message}`);
    statusBar.setError(message);

    const action = await vscode.window.showErrorMessage(
      `critiq: ${message}`,
      "Show Output",
      "Dismiss"
    );
    if (action === "Show Output") {
      outputChannel.show();
    }
  }
}

// ── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = new CritiqDiagnostics();
  const gutterDecorations = new CritiqGutterDecorations();
  const statusBar = new CritiqStatusBar();
  const outputChannel = vscode.window.createOutputChannel("critiq");

  // ── Tree view ──────────────────────────────────────────────────────────────
  const treeProvider = new CritiqTreeProvider();
  const treeView = vscode.window.createTreeView("critiqFindings", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    diagnostics,
    gutterDecorations,
    statusBar,
    outputChannel,
    treeView
  );

  // ── Review runner commands ──────────────────────────────────────────────────

  const reviewer = (mode: ReviewMode) =>
    runReview(mode, diagnostics, gutterDecorations, statusBar, treeProvider, outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewStaged", () =>
      reviewer({ kind: "staged" })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewBranch", async () => {
      const branch = await vscode.window.showInputBox({
        prompt: "Compare against branch",
        placeHolder: "main",
        value: "main",
      });
      if (!branch) return;
      reviewer({ kind: "branch", branch });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("critiq: No active editor.");
        return;
      }
      reviewer({ kind: "file", filePath: editor.document.uri.fsPath });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.clearDiagnostics", () => {
      diagnostics.clear();
      gutterDecorations.clear();
      statusBar.setIdle();
      clearReviewState();
      treeProvider.update(null, "");
      outputChannel.appendLine("[critiq] Diagnostics cleared.");
    })
  );

  // ── Fix + ignore commands ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "critiq.fixCurrentFile",
      (uri?: vscode.Uri) => fixCurrentFile(uri)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "critiq.learnIgnore",
      (pattern: string) => learnIgnorePattern(pattern)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.showOutput", () => {
      outputChannel.show();
    })
  );

  // ── Code action provider ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new CritiqCodeActionProvider(),
      { providedCodeActionKinds: CritiqCodeActionProvider.providedCodeActionKinds }
    )
  );

  // ── Re-apply gutter decorations when editors change ────────────────────────

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      const state = require("./reviewState").getReviewState();
      if (!state) return;
      for (const editor of editors) {
        gutterDecorations.applyToEditor(editor);
      }
    })
  );

  // ── Auto-review on save (if enabled) ──────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration("critiq");
      const autoReview = cfg.get<boolean>("autoReviewOnStage", false);
      if (!autoReview) return;

      const root = getWorkspaceRoot();
      if (root && doc.uri.fsPath.startsWith(root)) {
        reviewer({ kind: "staged" });
      }
    })
  );

  outputChannel.appendLine(
    "critiq v1.1.0 activated. Cmd+Shift+R to review staged changes. See the critiq panel in the sidebar."
  );
}

export function deactivate(): void {
  // subscriptions disposed automatically
}
