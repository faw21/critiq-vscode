/**
 * Shared state store — holds the last review result so Tree View,
 * Gutter Decorations, and Code Actions can all access it.
 */

import { CritiqResult } from "./critiq";

type Listener = () => void;

export class CritiqStore {
  private _result: CritiqResult | undefined;
  private _workspaceRoot: string = "";
  private readonly _listeners: Listener[] = [];

  // ── Mutations ─────────────────────────────────────────────────────────────

  setResult(result: CritiqResult, workspaceRoot: string): void {
    this._result = result;
    this._workspaceRoot = workspaceRoot;
    this._notify();
  }

  clear(): void {
    this._result = undefined;
    this._workspaceRoot = "";
    this._notify();
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  get result(): CritiqResult | undefined {
    return this._result;
  }

  get workspaceRoot(): string {
    return this._workspaceRoot;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  /** Subscribe to result changes. Returns unsubscribe function. */
  onDidChange(listener: Listener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) {
        this._listeners.splice(idx, 1);
      }
    };
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      fn();
    }
  }
}
