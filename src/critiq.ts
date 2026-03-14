/**
 * critiq CLI wrapper — executes critiq --json and parses output.
 */

import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";

// ── Types matching critiq --json output ─────────────────────────────────────

export interface CritiqComment {
  severity: "critical" | "warning" | "info" | "suggestion";
  file: string;
  line: string; // e.g. "L42" or "L42-50" or ""
  title: string;
  body: string;
  category: string;
}

export interface CritiqResult {
  summary: string;
  overall_rating: string;
  provider_model: string;
  comments: CritiqComment[];
}

// ── Config helpers ───────────────────────────────────────────────────────────

function getConfig() {
  return vscode.workspace.getConfiguration("critiq");
}

function buildArgs(extra: string[] = []): string[] {
  const cfg = getConfig();
  const args: string[] = ["--json"];

  const provider = cfg.get<string>("provider", "claude");
  args.push("--provider", provider);

  const model = cfg.get<string>("model", "");
  if (model) {
    args.push("--model", model);
  }

  const focus = cfg.get<string>("focus", "all");
  if (focus && focus !== "all") {
    args.push("--focus", focus);
  }

  const severity = cfg.get<string>("severity", "");
  if (severity) {
    args.push("--severity", severity);
  }

  return [...args, ...extra];
}

function buildEnv(): NodeJS.ProcessEnv {
  const cfg = getConfig();
  const env: NodeJS.ProcessEnv = { ...process.env };

  const anthropicKey = cfg.get<string>("anthropicApiKey", "");
  if (anthropicKey) {
    env["ANTHROPIC_API_KEY"] = anthropicKey;
  }

  const openaiKey = cfg.get<string>("openaiApiKey", "");
  if (openaiKey) {
    env["OPENAI_API_KEY"] = openaiKey;
  }

  return env;
}

// ── Run critiq ───────────────────────────────────────────────────────────────

export type ReviewMode =
  | { kind: "staged" }
  | { kind: "branch"; branch: string }
  | { kind: "file"; filePath: string };

export async function runCritiq(
  workspaceRoot: string,
  mode: ReviewMode
): Promise<CritiqResult> {
  const cfg = getConfig();
  const binary = cfg.get<string>("binaryPath", "critiq");

  const extra: string[] = [];
  if (mode.kind === "branch") {
    extra.push("--diff", mode.branch);
  } else if (mode.kind === "file") {
    // Make file path relative to workspace root
    const rel = path.relative(workspaceRoot, mode.filePath);
    extra.push("--file", rel);
  }
  // staged: no extra args needed (--staged is default)

  const args = buildArgs(extra);
  const env = buildEnv();

  return new Promise((resolve, reject) => {
    const proc = cp.spawn(binary, args, {
      cwd: workspaceRoot,
      env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `critiq binary not found: "${binary}". Install with: pip install critiq`
          )
        );
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        // Empty output = no staged changes or no diff
        resolve({
          summary: "No changes to review.",
          overall_rating: "✅ LGTM",
          provider_model: "",
          comments: [],
        });
        return;
      }

      try {
        const result = JSON.parse(trimmed) as CritiqResult;
        resolve(result);
      } catch {
        // Non-zero exit with no JSON = error from critiq
        const errMsg = stderr.trim() || stdout.trim();
        reject(new Error(`critiq error (exit ${code}): ${errMsg}`));
      }
    });
  });
}
