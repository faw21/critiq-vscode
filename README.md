# critiq — AI Code Reviewer for VS Code

AI-powered code review directly in VS Code. Reviews your git changes before you push, shows issues as inline diagnostics and in a dedicated sidebar panel, and auto-fixes issues with a single click. Supports Claude, OpenAI, or local Ollama.

## Features

- **Inline diagnostics** — findings appear as red/yellow squiggles and in the Problems panel
- **🌲 Findings Tree View** — dedicated sidebar panel showing all issues grouped by file, sorted by severity; click any issue to jump to the exact line
- **🔧 One-click Fix** — "Fix with critiq" lightbulb appears on any flagged line; auto-patches the file using the critiq CLI and refreshes diagnostics
- **Status bar** — always shows your current review status with issue counts (click to re-run)
- **Language-aware** — automatically detects Python, Go, TypeScript, Rust, JavaScript, and injects language-specific antipattern checks
- **Severity levels** — CRITICAL (error/red), WARNING (yellow), INFO (info), SUGGESTION (hint)
- **Multiple review modes** — staged changes, vs branch, or current file
- **Keyboard shortcut** — `Cmd+Shift+R` (Mac) / `Ctrl+Shift+R` (Windows/Linux)

## Requirements

Install the critiq CLI first:

```bash
pip install critiq
```

Set your API key (or use Ollama for zero-cost local review):

```bash
export ANTHROPIC_API_KEY=your-key   # Claude (default)
export OPENAI_API_KEY=your-key      # or OpenAI
```

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `critiq: Review Staged Changes` | `Cmd+Shift+R` | Review your `git add`-ed files |
| `critiq: Review Changes vs Branch` | — | Compare all changes vs a branch (e.g. `main`) |
| `critiq: Review Current File` | — | Review the file currently open in the editor |
| `critiq: Fix All Issues in File` | — | Auto-fix all issues in the current file using the critiq CLI |
| `critiq: Clear All Diagnostics` | — | Remove all critiq markers |

Commands are also accessible from:
- Command Palette (`Cmd+Shift+P` → type "critiq")
- Source Control panel (SCM title bar)
- Editor title bar

## Settings

| Setting | Default | Description |
|---|---|---|
| `critiq.provider` | `claude` | LLM provider: `claude`, `openai`, `ollama` |
| `critiq.model` | _(provider default)_ | Override model name |
| `critiq.focus` | `all` | Focus: `all`, `security`, `performance`, `readability`, `correctness`, `style` |
| `critiq.severity` | _(all)_ | Minimum severity to show: `critical`, `warning`, `info`, `suggestion` |
| `critiq.binaryPath` | `critiq` | Path to critiq binary (if not in PATH) |
| `critiq.anthropicApiKey` | — | Anthropic API key (overrides env var) |
| `critiq.openaiApiKey` | — | OpenAI API key (overrides env var) |
| `critiq.autoReviewOnStage` | `false` | Auto-review on file save |

### Example: Use Ollama locally (no API key)

```json
{
  "critiq.provider": "ollama",
  "critiq.model": "qwen2.5:1.5b"
}
```

### Example: Only show critical issues

```json
{
  "critiq.severity": "critical"
}
```

### Example: Always focus on security

```json
{
  "critiq.focus": "security"
}
```

## How it works

1. Press `Cmd+Shift+R` (or use the Command Palette)
2. critiq runs `critiq --json` on your staged changes
3. Findings appear as VS Code diagnostics (Problems panel + inline squiggles)
4. Open the **critiq sidebar** (shield icon) to see all findings grouped by file
5. Hover over any flagged line → click the 💡 lightbulb → "Fix with critiq"
6. Status bar shows issue count — click to re-run

The extension requires the [critiq CLI](https://github.com/faw21/critiq) (`pip install critiq`). All LLM calls are made by the CLI, not the extension itself — your API keys stay in your environment.

## Teach critiq your project preferences

Use `critiq-learn` in your terminal to customize what critiq checks:

```bash
# Don't flag these
critiq-learn ignore "Missing type annotations"

# Always check these
critiq-learn rule "Never use raw SQL strings"

# Set project defaults
critiq-learn set focus security
```

Preferences are saved to `.critiq.yaml` and picked up automatically on every review.

## Related

- [critiq](https://github.com/faw21/critiq) — the CLI tool this extension wraps
- [critiq-action](https://github.com/faw21/critiq-action) — GitHub Action for CI integration

---

Made by [@faw21](https://github.com/faw21) · [Report a bug](https://github.com/faw21/critiq-vscode/issues)
