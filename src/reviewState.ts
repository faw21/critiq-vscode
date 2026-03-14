/**
 * Shared state for the current review result.
 * Used by diagnostics, gutter decorations, code actions, and tree view.
 */

import { CritiqResult } from "./critiq";

interface ReviewState {
  result: CritiqResult;
  root: string;
  /** The last-used review mode kind (staged | branch | file) */
  mode: "staged" | "branch" | "file";
  /** For branch mode: which branch was compared */
  branch?: string;
}

let _state: ReviewState | null = null;

const _listeners: Array<(state: ReviewState | null) => void> = [];

export function setReviewState(
  result: CritiqResult,
  root: string,
  mode: "staged" | "branch" | "file",
  branch?: string
): void {
  _state = { result, root, mode, branch };
  _listeners.forEach((fn) => fn(_state));
}

export function getReviewState(): ReviewState | null {
  return _state;
}

export function clearReviewState(): void {
  _state = null;
  _listeners.forEach((fn) => fn(null));
}

/** Subscribe to state changes (review run or clear). Returns unsubscribe fn. */
export function onReviewStateChange(
  fn: (state: ReviewState | null) => void
): () => void {
  _listeners.push(fn);
  return () => {
    const idx = _listeners.indexOf(fn);
    if (idx >= 0) {
      _listeners.splice(idx, 1);
    }
  };
}
