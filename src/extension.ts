/**
 * critiq VS Code extension — entry point.
 *
 * Commands registered:
 *   critiq.reviewStaged       — review staged git changes (Cmd+Shift+R)
 *   critiq.reviewBranch       — review all changes vs a branch
 *   critiq.reviewFile         — review current open file
 *   critiq.clearDiagnostics   — clear all critiq diagnostics
 *   critiq.fixCurrentFile     — auto-fix issues in a file via critiq --fix-all
 *   critiq.learnIgnore        — run critiq-learn ignore <pattern>
 *   critiq.showOutput         — reveal the critiq output channel
 */

import * as vscode from "vscode";
import { CritiqResult, ReviewMode, runCritiq } from "./critiq";
import {
  CritiqCodeActionProvider,
  fixCurrentFile,
  learnIgnorePattern,
} from "./codeActions";
import { CritiqDiagnostics } from "./diagnostics";
import { CritiqGutterDecorations } from "./gutterDecorations";
import { CritiqStatusBar } from "./statusBar";
import { CritiqTreeProvider } from "./treeView";
import {
  setReviewState,
  clearReviewState,
} from "./reviewState";

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

    // Update shared state (used by code actions)
    setReviewState(
      result,
      root,
      mode.kind,
      mode.kind === "branch" ? mode.branch : undefined
    );

    diagnostics.apply(result, root);
    statusBar.setResult(result);
    treeProvider.update(result, root);
    gutterDecorations.apply(result, root);

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
          : c.severity === "info"    ? "ℹ️ "
          : "💡";
        outputChannel.appendLine(
          `  ${icon} [${c.severity.toUpperCase()}] ${c.title}`
        );
        if (c.file) outputChannel.appendLine(`     ${c.file} ${c.line}`);
        if (c.body) {
          const bodyShort = c.body.replace(/\*\*/g, "").split("\n")[0];
          outputChannel.appendLine(`     ${bodyShort}`);
        }
      }
    }

    // Notification for critical issues
    const critical = result.comments.filter((c) => c.severity === "critical").length;
    if (critical > 0) {
      const action = await vscode.window.showWarningMessage(
        `critiq found ${critical} critical issue(s)`,
        "Fix Current File",
        "Show Problems",
        "Dismiss"
      );
      if (action === "Fix Current File") {
        vscode.commands.executeCommand(
          "critiq.fixCurrentFile",
          vscode.window.activeTextEditor?.document.uri
        );
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

  // Register tree view (activity bar panel)
  const treeView = vscode.window.createTreeView("critiqFindings", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    diagnostics,
    statusBar,
    outputChannel,
    treeView,
    { dispose: () => gutterDecorations.dispose() }
  );

  // Helper to run review commands
  const review = (mode: ReviewMode) =>
    runReview(mode, diagnostics, statusBar, outputChannel, treeProvider, gutterDecorations);

  // ── Review commands ────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewStaged", () =>
      review({ kind: "staged" })
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewBranch", async () => {
      const branch = await vscode.window.showInputBox({
        prompt: "Compare against branch",
        placeHolder: "main",
        value: "main",
      });
      if (branch) review({ kind: "branch", branch });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.reviewFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("critiq: No active editor.");
        return;
      }
      review({ kind: "file", filePath: editor.document.uri.fsPath });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.clearDiagnostics", () => {
      clearReviewState();
      diagnostics.clear();
      statusBar.setIdle();
      treeProvider.update(null, "");
      gutterDecorations.clear();
      outputChannel.appendLine("[critiq] Diagnostics cleared.");
    })
  );

  // ── Fix current file ───────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "critiq.fixCurrentFile",
      (uri?: vscode.Uri) => fixCurrentFile(uri)
    )
  );

  // ── Learn ignore pattern ───────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "critiq.learnIgnore",
      (pattern: string) => learnIgnorePattern(pattern)
    )
  );

  // ── Show output ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("critiq.showOutput", () => {
      outputChannel.show();
    })
  );

  // ── Code Action provider ───────────────────────────────────────────────────

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

  // ── Apply gutter decorations when user switches editors ───────────────────

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) gutterDecorations.applyToEditor(editor);
    })
  );

  // ── Auto-review on save (if enabled) ──────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration("critiq");
      if (!cfg.get<boolean>("autoReviewOnStage", false)) return;
      const root = getWorkspaceRoot();
      if (root && doc.uri.fsPath.startsWith(root)) {
        review({ kind: "staged" });
      }
    })
  );

  outputChannel.appendLine(
    "critiq extension activated. Use Cmd+Shift+R (or Ctrl+Shift+R) to review staged changes."
  );
}

export function deactivate(): void {
  // Subscriptions are disposed automatically.
}
