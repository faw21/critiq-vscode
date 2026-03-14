/**
 * Status bar item showing the last critiq review result.
 */

import * as vscode from "vscode";
import { CritiqResult } from "./critiq";

export class CritiqStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "critiq.reviewStaged";
    this.item.text = "$(eye) critiq";
    this.item.tooltip = "Click to run critiq review";
    this.item.show();
  }

  setRunning(): void {
    this.item.text = "$(loading~spin) critiq: reviewing…";
    this.item.tooltip = "critiq is running…";
    this.item.backgroundColor = undefined;
  }

  setResult(result: CritiqResult): void {
    const critical = result.comments.filter(
      (c) => c.severity === "critical"
    ).length;
    const warnings = result.comments.filter(
      (c) => c.severity === "warning"
    ).length;
    const total = result.comments.length;

    if (critical > 0) {
      this.item.text = `$(error) critiq: ${critical} critical`;
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      this.item.tooltip = `critiq: ${critical} critical, ${warnings} warnings — click to re-run`;
    } else if (warnings > 0) {
      this.item.text = `$(warning) critiq: ${warnings} warnings`;
      this.item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      this.item.tooltip = `critiq: ${warnings} warnings — click to re-run`;
    } else if (total > 0) {
      this.item.text = `$(info) critiq: ${total} suggestions`;
      this.item.backgroundColor = undefined;
      this.item.tooltip = `critiq: ${total} suggestions — click to re-run`;
    } else {
      this.item.text = "$(check) critiq: clean";
      this.item.backgroundColor = undefined;
      this.item.tooltip = "critiq: no issues found — click to re-run";
    }
  }

  setError(message: string): void {
    this.item.text = "$(x) critiq: error";
    this.item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
    this.item.tooltip = `critiq error: ${message}`;
  }

  setIdle(): void {
    this.item.text = "$(eye) critiq";
    this.item.tooltip = "Click to run critiq review";
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
