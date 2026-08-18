# quota-pilot

Reads your **live** Claude Code and Codex CLI subscription usage, then asks an
agent (not a hardcoded rule) which one you should use — optionally for a
specific task you describe.

```
npx quota-pilot
npx quota-pilot "refactor the auth middleware across 6 files, will take a while"
npx quota-pilot --via claude "quick one-line fix in a config file"
npx quota-pilot --json
```

## How it gets the data

- **Codex** (`src/codexUsage.mjs`): talks to `codex app-server` over its
  JSON-RPC/stdio protocol (`account/read`, `account/rateLimits/read`). This is
  a real, documented API — exact `usedPercent` / `resetsAt` per limit bucket,
  same numbers as the `/status` panel.
- **Claude** (`src/claudeUsage.mjs`): Claude Code has **no equivalent API** —
  the weekly-limit percentages only exist inside the interactive `/status`
  TUI panel, and specifically under its **Usage** tab (the default tab only
  shows session/account/model info, not quota). This module opens its own
  pty pair via a small embedded Python helper (`pty.openpty` + `subprocess`),
  spawns `claude` attached to it, sends `/status`, presses → twice to reach
  the Usage tab, and captures the rendered screen. Terminal UIs move between
  rows with cursor-addressing escape codes rather than `\n`, so the parser
  converts row-transition codes to real newlines before stripping the rest
  of the ANSI codes — otherwise the whole capture collapses into one
  unreadable line. The *raw* captured text (several stacked screen redraws)
  is handed to the suggestion agent as-is instead of being regex-parsed into
  fixed fields, since the TUI layout can change.

  Earlier version used the `script` utility for the pty, which turned out to
  be unreliable — it depends on `tcgetattr` succeeding against *your*
  controlling terminal and fails with "Operation not supported on socket" in
  some terminal setups even when your shell looks perfectly normal. The
  Python-based approach opens a fresh pty independent of your own terminal,
  so it doesn't have that failure mode. It does need `python3` (or `python`)
  on PATH.

  Run `--debug` to save the raw pty capture to a temp file if you want to
  see exactly what got read. If capture fails, the tool degrades gracefully:
  it reports the error and still asks for a recommendation using whatever
  data it did get.

## How the suggestion works

No fixed decision table. `src/suggest.mjs` builds a prompt containing both
usage snapshots plus your task description (if given), and runs it through a
real agent:

- `--via codex` (default): `codex exec --skip-git-repo-check -s read-only`,
  using the fast `gpt-5.3-codex-spark` model by default so *asking* for the
  recommendation doesn't spend the main-pool quota it's reasoning about
- `--via claude`: `claude -p --output-format json`

Both are read-only, single-turn, non-interactive calls — no file/shell tool
access, just reasoning over the usage data you already fetched.

The prompt explicitly tells the agent that `gpt-5.3-codex-spark` is a
fast/lightweight lane meant only for small, trivial tasks (typo fixes,
one-liners) — having full quota left is not a reason to route bigger or
harder work to it. It's asked for a decisive answer plus a short
short-task/long-task routing guide, not just a data dump.

## Flags

| Flag | Effect |
|---|---|
| `--via <codex\|claude>` | Which CLI answers the recommendation (default `codex`) |
| `--model <name>` | Model for the recommendation call (default via codex: `gpt-5.3-codex-spark`) |
| `--json` | Print raw usage data instead of asking for a suggestion |
| `--no-claude` | Skip the Claude `/status` capture |
| `--no-codex` | Skip the Codex app-server read |
| `--debug` | Save the raw Claude pty capture to a temp file for troubleshooting |

## Requirements

- Node 18+
- `python3` (or `python`) on PATH — used only to open a pty for the Claude
  `/status` capture, not for anything else
- `codex` and/or `claude` CLIs installed and already logged in
- Zero npm dependencies — everything uses Node's stdlib plus the two CLIs
  and Python's stdlib.

## Publishing

`.github/workflows/publish.yml` publishes to npm on a version tag push (or
via manual "Run workflow" in the Actions tab). It reads an npm access token
from the repo secret `NPM_TOKEN` — add one under GitHub repo Settings →
Secrets and variables → Actions → New repository secret, using an npm
[automation/publish token](https://docs.npmjs.com/creating-and-viewing-access-tokens).

To ship a release:

```
npm version patch   # or minor / major — bumps package.json and tags it
git push --follow-tags
```

The workflow checks the pushed tag matches `package.json`'s version before
publishing, then runs `npm publish --access public --provenance`. Once
published, `npx quota-pilot` resolves to it automatically — no separate step
needed for npx itself.
# quota-pilot
# quota-pilot
