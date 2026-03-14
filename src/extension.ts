/**
 * critiq VS Code extension — entry point v1.3.0
 *
 * Features:
 *   - Inline diagnostics (Problems panel) with severity colours
 *   - Gutter icons + inline ghost-text hints (GitLens-style)
 *   - Sidebar Tree View of all findings grouped by severity/file
 *   - Code Action lightbulb: "Fix with critiq" + "Ignore issue type"
 *   - Status bar: live issue count, click to re-review
 *
 * Commands:
 *   critiq.reviewStaged      — review staged changes (Cmd+Shift+R)
 *   critiq.reviewBranch      — review vs a branch
 *   critiq.reviewFile        — review current open file
 *   critiq.clearDiagnostics  — clear all diagnostics
 *   critiq.fixCurrentFile    — auto-fix all issues in a file (Code Action)
 *   critiq.learnIgnore       — add ignore pattern via critiq-learn (Code Action)
 *   critiq.showOutput        — show critiq output channel (Code Action)
 *   critiq.openIssue         — navigate to file/line (Tree View)
 */

import * as path from "path";
import * as vscode from "vscode";
import { ReviewMode, runCritiq } from "./critiq";
import {
  CritiqCodeActionProvider,
  fixCurrentFile,
  learnIgnorePattern,
} from "./codeActions";
import { CritiqDiagnostics } from "./diagnostics";
import { CritiqGutterDecorations } from "./gutterDecorations";
import { CritiqStatusBar } from "./statusBar";
import {
  setReviewState,
  clearReviewState,
} from "./reviewState";
import { CritiqTreeProvider } from "./treeView";

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// ── Core review runner ───────────────────────────────────────────────────────

async function runReview(
  mode: ReviewMode,
  diagnostics: CritiqDiagnostics,
  gutter: CritiqGutterDecorations,
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

    // Update shared state (used by Code Actions)
    const branch = mode.kind === "branch" ? mode.branch : undefined;
    setReviewState(result, root, mode.kind, branch);

    // Update all views
    diagnostics.apply(result, root);
    gutter.apply(result, root);
    statusBar.setResult(result);
    treeProvider.update(result, root);

    // Log to output channel
    const critical = result.comments.filter((c) => c.severity === "critical").length;
    const warnings = result.comments.filter((c) => c.severity === "warning").length;
    const info = result.comments.filter(
      (c) => c.severity === "info" || c.severity === "suggestion"
    ).length;

    const summary =
      result.comments.length === 0
        ? `✅ No issues found. ${result.summary}`
        : `${result.overall_rating}  ${[
            critical > 0 ? `${critical} critical` : "",
            warnings > 0 ? `${warnings} warnings` : "",
            info > 0 ? `${info} suggestions` : "",
          ]
            .filter(Boolean)
            .join(", ")}`;

    outputChannel.appendLine(`[critiq] ${summary}`);
    if (result.summary && result.comments.length > 0) {
      outputChannel.appendLine(`         ${result.summary}`);
    }
    for (const c of result.comments) {
      const icon =
        c.severity === "critical" ? "🚨"
        : c.severity === "warning" ? "⚠️ "
        : c.severity === "info"    ? "ℹ️ "
        : "💡";
      outputChannel.appendLine(`  ${icon} [${c.severity.toUpperCase()}] ${c.title}`);
      if (c.file) outputChannel.appendLine(`     ${c.file} ${c.line}`);
      if (c.body) {
        outputChannel.appendLine(`     ${c.body.replace(/\*\*/g, "").split("\n")[0]}`);
      }
    }

    // Notification
    if (critical > 0) {
      const action = await vscode.window.showWarningMessage(
        `critiq found ${critical} critical issue(s)`,
        "Fix All",
        "Show Problems",
        "Dismiss"
      );
      if (action === "Fix All") {
        const files = [
          ...new Set(result.comments.map((c) => c.file).filter(Boolean)),
        ];
        for (const file of files) {
          const absPath = file.startsWith("/")
            ? file
            : path.join(root, file);
          await fixCurrentFile(vscode.Uri.file(absPath));
        }
        // Refresh after fixes
        await runReview(mode, diagnostics, gutter, statusBar, treeProvider, outputChannel);
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
    if (action === "Show Output") outputChannel.show();
  }
}

// ── Extension lifecycle ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics   = new CritiqDiagnostics();
  const gutter        = new CritiqGutterDecorations();
  const statusBar     = new CritiqStatusBar();
  const treeProvider  = new CritiqTreeProvider();
  const outputChannel = vscode.window.createOutputChannel("critiq");

  const treeView = vscode.window.createTreeView("critiqFindings", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    diagnostics,
    statusBar,
    outputChannel,
    treeView,
    { dispose: () => gutter.dispose() }
  );

  // Apply gutter decorations when switching editors
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) gutter.applyToEditor(editor);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) gutter.applyToEditor(editor);
    })
  );

  // Code Action provider (lightbulb)
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new CritiqCodeActionProvider(),
      {
        providedCodeActionKinds:
          CritiqCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // ── Review commands ───────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewStaged", () =>
      runReview(
        { kind: "staged" },
        diagnostics, gutter, statusBar, treeProvider, outputChannel
      )
    ),
    vscode.commands.registerCommand("critiq.reviewBranch", async () => {
      const branch = await vscode.window.showInputBox({
        prompt: "Compare against branch",
        placeHolder: "main",
        value: "main",
      });
      if (!branch) return;
      runReview(
        { kind: "branch", branch },
        diagnostics, gutter, statusBar, treeProvider, outputChannel
      );
    }),
    vscode.commands.registerCommand("critiq.reviewFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("critiq: No active editor.");
        return;
      }
      runReview(
        { kind: "file", filePath: editor.document.uri.fsPath },
        diagnostics, gutter, statusBar, treeProvider, outputChannel
      );
    }),
    vscode.commands.registerCommand("critiq.clearDiagnostics", () => {
      clearReviewState();
      diagnostics.clear();
      gutter.clear();
      statusBar.setIdle();
      treeProvider.update(null, "");
      outputChannel.appendLine("[critiq] Diagnostics cleared.");
    })
  );

  // ── Code Action commands ──────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "critiq.fixCurrentFile",
      (uri?: vscode.Uri) => fixCurrentFile(uri)
    ),
    vscode.commands.registerCommand(
      "critiq.learnIgnore",
      (pattern: string) => learnIgnorePattern(pattern)
    ),
    vscode.commands.registerCommand("critiq.showOutput", () => {
      outputChannel.show();
    })
  );

  // ── Open issue (Tree View click) ──────────────────────────────────────────

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
            `critiq: Could not open ${filePath}`
          );
        }
      }
    )
  );

  // ── Auto-review on save ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration("critiq");
      if (!cfg.get<boolean>("autoReviewOnStage", false)) return;
      const root = getWorkspaceRoot();
      if (root && doc.uri.fsPath.startsWith(root)) {
        runReview(
          { kind: "staged" },
          diagnostics, gutter, statusBar, treeProvider, outputChannel
        );
      }
    })
  );

  outputChannel.appendLine(
    "critiq activated. Use Cmd+Shift+R (Mac) / Ctrl+Shift+R to review staged changes."
  );
}

export function deactivate(): void {
  // Subscriptions disposed automatically.
}
