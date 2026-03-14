/**
 * critiq Code Action Provider — shows a "Fix with critiq" lightbulb on
 * diagnostics raised by the critiq extension.
 *
 * When activated it spawns `critiq --file <relative-path> --fix-all` in the
 * workspace root, which modifies the file in-place and creates a .critiq.bak
 * backup. VS Code detects the file change automatically.
 */

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";

// ── Fix runner ───────────────────────────────────────────────────────────────

export async function runCritiqFix(
  workspaceRoot: string,
  filePath: string
): Promise<{ fixed: boolean; message: string }> {
  const cfg = vscode.workspace.getConfiguration("critiq");
  const binary = cfg.get<string>("binaryPath", "critiq");
  const provider = cfg.get<string>("provider", "claude");
  const model = cfg.get<string>("model", "");

  const relPath = path.relative(workspaceRoot, filePath);
  const args = ["--file", relPath, "--fix-all", "--provider", provider];
  if (model) {
    args.push("--model", model);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  const anthropicKey = cfg.get<string>("anthropicApiKey", "");
  if (anthropicKey) {
    env["ANTHROPIC_API_KEY"] = anthropicKey;
  }
  const openaiKey = cfg.get<string>("openaiApiKey", "");
  if (openaiKey) {
    env["OPENAI_API_KEY"] = openaiKey;
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = cp.spawn(binary, args, { cwd: workspaceRoot, env });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      const msg =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `critiq binary not found: "${binary}". Install with: pip install critiq`
          : err.message;
      resolve({ fixed: false, message: msg });
    });

    proc.on("close", (code) => {
      if (code === 0 || code === 1) {
        // 0 = no issues / nothing to fix, 1 = had critical issues (still ok)
        const combined = (stdout + stderr).trim();
        resolve({ fixed: true, message: combined || "Fix applied." });
      } else {
        const errMsg = (stderr || stdout).trim();
        resolve({ fixed: false, message: errMsg || `critiq exited with code ${code}` });
      }
    });
  });
}

// ── Code action ──────────────────────────────────────────────────────────────

export class CritiqCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    // Only offer actions when there are critiq diagnostics on this line/range
    const critiqDiags = context.diagnostics.filter(
      (d) => d.source === "critiq"
    );
    if (critiqDiags.length === 0) {
      return [];
    }

    const action = new vscode.CodeAction(
      "🔧 Fix with critiq (auto-fix all issues in this file)",
      vscode.CodeActionKind.QuickFix
    );
    action.command = {
      command: "critiq.fixFile",
      title: "Fix with critiq",
      arguments: [document.uri.fsPath],
    };
    // Mark as preferred so it appears first in the lightbulb menu
    action.isPreferred = true;
    action.diagnostics = critiqDiags;

    return [action];
  }
}
