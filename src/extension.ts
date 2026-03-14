/**
 * critiq VS Code extension — entry point.
 *
 * Commands:
 *   critiq.reviewStaged      — review staged git changes (default, Cmd+Shift+R)
 *   critiq.reviewBranch      — review all changes vs a branch
 *   critiq.reviewFile        — review current open file's changes
 *   critiq.clearDiagnostics  — clear all critiq diagnostics
 *   critiq.fixFile           — auto-fix all issues in a file (Code Action)
 *   critiq.openIssue         — navigate to an issue location (Tree View)
 */

import * as vscode from "vscode";
import { CritiqResult, ReviewMode, runCritiq } from "./critiq";
import { CritiqCodeActionProvider, runCritiqFix } from "./codeAction";
import { CritiqDiagnostics } from "./diagnostics";
import { CritiqGutterDecorations } from "./gutterDecorations";
import { CritiqStatusBar } from "./statusBar";
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
  outputChannel: vscode.OutputChannel,
  treeProvider: CritiqTreeProvider,
  gutterDecorations: CritiqGutterDecorations
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
    treeProvider.update(result, root);
    gutterDecorations.update(result, root);

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
        "Fix All",
        "Show Problems",
        "Dismiss"
      );
      if (action === "Fix All") {
        // Fix all files that have issues
        const files = [...new Set(result.comments.map((c) => c.file).filter(Boolean))];
        for (const file of files) {
          const absPath = file.startsWith("/") ? file : `${root}/${file}`;
          await vscode.commands.executeCommand("critiq.fixFile", absPath);
        }
      } else if (action === "Show Problems") {
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
  const treeProvider = new CritiqTreeProvider();
  const gutterDecorations = new CritiqGutterDecorations();

  // Register tree view
  const treeView = vscode.window.createTreeView("critiqFindings", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    diagnostics,
    statusBar,
    outputChannel,
    treeView,
    gutterDecorations,
    // Apply gutter decorations whenever user switches to an editor
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        gutterDecorations.applyToEditor(editor);
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        gutterDecorations.applyToEditor(editor);
      }
    })
  );

  // ── Review commands ────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewStaged", () =>
      runReview(
        { kind: "staged" },
        diagnostics,
        statusBar,
        outputChannel,
        treeProvider,
        gutterDecorations
      )
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
        outputChannel,
        treeProvider,
        gutterDecorations
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
        outputChannel,
        treeProvider,
        gutterDecorations
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.clearDiagnostics", () => {
      diagnostics.clear();
      statusBar.setIdle();
      treeProvider.clear();
      gutterDecorations.clear();
      outputChannel.appendLine("[critiq] Diagnostics cleared.");
    })
  );

  // ── Fix command (used by Code Actions and review notification) ─────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "critiq.fixFile",
      async (filePath?: string) => {
        const root = getWorkspaceRoot();
        if (!root) {
          vscode.window.showErrorMessage("critiq: No workspace folder open.");
          return;
        }

        // Default to active editor if no filePath provided
        const targetPath =
          filePath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!targetPath) {
          vscode.window.showErrorMessage(
            "critiq: No file to fix. Open a file or run a review first."
          );
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `critiq: Fixing issues in ${require("path").basename(targetPath)}…`,
            cancellable: false,
          },
          async () => {
            const { fixed, message } = await runCritiqFix(root, targetPath);
            if (fixed) {
              outputChannel.appendLine(
                `[critiq] Fixed: ${require("path").basename(targetPath)}`
              );
              // Re-run review to refresh diagnostics after fix
              await runReview(
                { kind: "staged" },
                diagnostics,
                statusBar,
                outputChannel,
                treeProvider,
                gutterDecorations
              );
            } else {
              vscode.window.showErrorMessage(`critiq fix failed: ${message}`);
              outputChannel.appendLine(
                `[critiq] Fix error: ${message}`
              );
            }
          }
        );
      }
    )
  );

  // ── Open issue (Tree View click) ───────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "critiq.openIssue",
      async (filePath: string, lineNum: number) => {
        try {
          const uri = vscode.Uri.file(filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc);
          const line = Math.min(lineNum, doc.lineCount - 1);
          const range = new vscode.Range(line, 0, line, 0);
          editor.selection = new vscode.Selection(range.start, range.start);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch {
          vscode.window.showErrorMessage(
            `critiq: Could not open file: ${filePath}`
          );
        }
      }
    )
  );

  // ── Code Action provider ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new CritiqCodeActionProvider(),
      { providedCodeActionKinds: CritiqCodeActionProvider.providedCodeActionKinds }
    )
  );

  // ── Auto-review on save (if enabled) ──────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration("critiq");
      const autoReview = cfg.get<boolean>("autoReviewOnStage", false);
      if (!autoReview) {
        return;
      }
      const root = getWorkspaceRoot();
      if (root && doc.uri.fsPath.startsWith(root)) {
        runReview(
          { kind: "staged" },
          diagnostics,
          statusBar,
          outputChannel,
          treeProvider,
          gutterDecorations
        );
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
