/**
 * critiq VS Code extension — entry point.
 *
 * Commands:
 *   critiq.reviewStaged    — review staged git changes (default, Cmd+Shift+R)
 *   critiq.reviewBranch    — review all changes vs a branch
 *   critiq.reviewFile      — review current open file's changes
 *   critiq.clearDiagnostics — clear all critiq diagnostics
 */

import * as vscode from "vscode";
import { CritiqResult, ReviewMode, runCritiq } from "./critiq";
import { CritiqDiagnostics } from "./diagnostics";
import { CritiqStatusBar } from "./statusBar";

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
  if (critical > 0) {
    parts.push(`${critical} critical`);
  }
  if (warnings > 0) {
    parts.push(`${warnings} warnings`);
  }
  if (info > 0) {
    parts.push(`${info} suggestions`);
  }
  return `${result.overall_rating}  ${parts.join(", ")}`;
}

// ── Core review runner ───────────────────────────────────────────────────────

async function runReview(
  mode: ReviewMode,
  diagnostics: CritiqDiagnostics,
  statusBar: CritiqStatusBar,
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

    diagnostics.apply(result, root);
    statusBar.setResult(result);

    const summary = summariseResult(result);
    outputChannel.appendLine(`[critiq] ${summary}`);

    if (result.summary) {
      outputChannel.appendLine(`         ${result.summary}`);
    }

    if (result.comments.length > 0) {
      outputChannel.appendLine("");
      for (const c of result.comments) {
        const icon =
          c.severity === "critical"
            ? "🚨"
            : c.severity === "warning"
            ? "⚠️ "
            : c.severity === "info"
            ? "ℹ️ "
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

    // Show notification for critical issues
    const critical = result.comments.filter(
      (c) => c.severity === "critical"
    ).length;
    if (critical > 0) {
      const action = await vscode.window.showWarningMessage(
        `critiq found ${critical} critical issue(s)`,
        "Show Problems",
        "Dismiss"
      );
      if (action === "Show Problems") {
        vscode.commands.executeCommand("workbench.action.problems.focus");
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
  const statusBar = new CritiqStatusBar();
  const outputChannel = vscode.window.createOutputChannel("critiq");

  context.subscriptions.push(diagnostics, statusBar, outputChannel);

  // ── Commands ───────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewStaged", () =>
      runReview({ kind: "staged" }, diagnostics, statusBar, outputChannel)
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewBranch", async () => {
      const branch = await vscode.window.showInputBox({
        prompt: "Compare against branch",
        placeHolder: "main",
        value: "main",
      });
      if (!branch) {
        return;
      }
      runReview(
        { kind: "branch", branch },
        diagnostics,
        statusBar,
        outputChannel
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("critiq: No active editor.");
        return;
      }
      const filePath = editor.document.uri.fsPath;
      runReview(
        { kind: "file", filePath },
        diagnostics,
        statusBar,
        outputChannel
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.clearDiagnostics", () => {
      diagnostics.clear();
      statusBar.setIdle();
      outputChannel.appendLine("[critiq] Diagnostics cleared.");
    })
  );

  // ── Auto-review on save (if enabled) ──────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration("critiq");
      const autoReview = cfg.get<boolean>("autoReviewOnStage", false);
      if (!autoReview) {
        return;
      }
      // Only review if the saved file is tracked by git (heuristic: in workspace)
      const root = getWorkspaceRoot();
      if (root && doc.uri.fsPath.startsWith(root)) {
        runReview({ kind: "staged" }, diagnostics, statusBar, outputChannel);
      }
    })
  );

  outputChannel.appendLine(
    "critiq extension activated. Use Cmd+Shift+R (or Ctrl+Shift+R) to review staged changes."
  );
}

export function deactivate(): void {
  // Nothing to clean up; subscriptions are disposed automatically.
}
