/**
 * Code action provider — offers "Fix with critiq" and "Ignore pattern"
 * lightbulb actions on lines with critiq diagnostics.
 */

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { getReviewState } from "./reviewState";

// ── Helper: run a critiq command in background ────────────────────────────────

function runCritiqCommand(
  args: string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cfg = vscode.workspace.getConfiguration("critiq");
  const binary = cfg.get<string>("binaryPath", "critiq");

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = cp.spawn(binary, args, { cwd });
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
    proc.on("error", () => resolve({ exitCode: 1, stdout, stderr: "critiq binary not found" }));
  });
}

// ── Commands registered by the extension ─────────────────────────────────────

/** Fix all issues in the current file using critiq --fix-all */
export async function fixCurrentFile(
  uri: vscode.Uri | undefined
): Promise<void> {
  const state = getReviewState();
  if (!state) {
    vscode.window.showWarningMessage(
      "critiq: No review result available. Run a review first."
    );
    return;
  }

  const fileUri =
    uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!fileUri) {
    vscode.window.showWarningMessage("critiq: No file selected.");
    return;
  }

  const relPath = path.relative(state.root, fileUri.fsPath);
  const cfg = vscode.workspace.getConfiguration("critiq");
  const provider = cfg.get<string>("provider", "claude");

  const args = ["--fix-all", "--file", relPath, "--provider", provider];

  // Add branch/mode context
  if (state.mode === "branch" && state.branch) {
    args.push("--diff", state.branch);
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `critiq: Fixing issues in ${path.basename(relPath)}…`,
      cancellable: false,
    },
    async () => {
      const result = await runCritiqCommand(args, state.root);
      if (result.exitCode === 0 || result.exitCode === 1) {
        // Revert the document to pick up on-disk changes made by critiq
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.commands.executeCommand(
          "workbench.action.files.revert",
          fileUri
        );
        vscode.window.showInformationMessage(
          `critiq: ✅ Fixes applied to ${path.basename(relPath)}`
        );
      } else {
        vscode.window.showErrorMessage(
          `critiq --fix-all failed: ${result.stderr.trim() || result.stdout.trim()}`
        );
      }
    }
  );
}

/** Learn to ignore a pattern via critiq-learn ignore */
export async function learnIgnorePattern(pattern: string): Promise<void> {
  const state = getReviewState();
  if (!state) {
    vscode.window.showWarningMessage(
      "critiq: No workspace context available."
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("critiq");
  const binary = cfg.get<string>("binaryPath", "critiq");
  // critiq-learn is a separate entry point; derive it from binary path
  const learnBinary = binary.replace(/critiq$/, "critiq-learn");

  const result = await runCritiqCommand(["ignore", pattern], state.root);
  vscode.window.showInformationMessage(
    `critiq-learn: Pattern ignored — "${pattern}"`
  );
}

// ── Code action provider ─────────────────────────────────────────────────────

export class CritiqCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const critiqDiags = context.diagnostics.filter(
      (d) => d.source === "critiq"
    );
    if (critiqDiags.length === 0) return [];

    const actions: vscode.CodeAction[] = [];

    // ── Action 1: Fix with critiq ─────────────────────────────────────────
    const fixAction = new vscode.CodeAction(
      "Fix with critiq (auto-apply all fixes in this file)",
      vscode.CodeActionKind.QuickFix
    );
    fixAction.command = {
      command: "critiq.fixCurrentFile",
      title: "Fix with critiq",
      arguments: [document.uri],
    };
    fixAction.diagnostics = critiqDiags;
    fixAction.isPreferred = false;
    actions.push(fixAction);

    // ── Action 2: Ignore this pattern ────────────────────────────────────
    if (critiqDiags.length === 1) {
      const diag = critiqDiags[0];
      // Extract issue title from diagnostic message (format: [SEVERITY] Title · body)
      const match = diag.message.match(/\[\w+\]\s+(.+?)(?:\s+·|$)/);
      if (match) {
        const title = match[1].trim();
        const ignoreAction = new vscode.CodeAction(
          `Tell critiq to ignore: "${title.slice(0, 50)}"`,
          vscode.CodeActionKind.QuickFix
        );
        ignoreAction.command = {
          command: "critiq.learnIgnore",
          title: "Ignore pattern",
          arguments: [title],
        };
        ignoreAction.diagnostics = [diag];
        actions.push(ignoreAction);
      }
    }

    // ── Action 3: Open critiq output ──────────────────────────────────────
    const showAction = new vscode.CodeAction(
      "Show critiq review output",
      vscode.CodeActionKind.QuickFix
    );
    showAction.command = {
      command: "critiq.showOutput",
      title: "Show critiq output",
    };
    actions.push(showAction);

    return actions;
  }
}
