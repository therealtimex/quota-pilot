#!/usr/bin/env node
import { getCodexUsage } from "../src/codexUsage.mjs";
import { getClaudeUsage } from "../src/claudeUsage.mjs";
import { getSuggestion } from "../src/suggest.mjs";
import { formatCompact, mentionsSpark } from "../src/usageView.mjs";

function parseArgs(argv) {
  const args = { task: "", via: "codex", model: undefined, json: false, skipClaude: false, skipCodex: false, debug: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--via") args.via = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--no-claude") args.skipClaude = true;
    else if (a === "--no-codex") args.skipCodex = true;
    else if (a === "--debug") args.debug = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else rest.push(a);
  }
  args.task = rest.join(" ");
  return args;
}

function printHelp() {
  console.log(`quota-pilot — check live Claude/Codex CLI usage and ask an agent what to use next

Usage:
  npx quota-pilot ["task description"]

Options:
  --via <codex|claude>   Which CLI to ask for the recommendation (default: codex)
  --model <name>         Model for the recommendation call
  --json                 Also print raw usage data as JSON (compact view still shown)
  --no-claude            Skip the Claude /status capture (Codex data only)
  --no-codex             Skip the Codex app-server read (Claude data only)
  --debug                Save the raw Claude /status pty capture to a temp file
  -h, --help             Show this help

A compact usage summary is always printed first. The Codex "Spark" lane
(gpt-5.3-codex-spark) is left out of both the summary and the suggestion
unless your task text mentions "spark" — it's a cheap/fast lane that's easy
to over-recommend just because it usually has full quota.

Examples:
  npx quota-pilot
  npx quota-pilot "refactor the auth middleware across 6 files, will take a while"
  npx quota-pilot --via claude "quick one-line fix in a config file"
  npx quota-pilot --json
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const [codexUsage, claudeUsage] = await Promise.all([
    args.skipCodex
      ? Promise.resolve(null)
      : getCodexUsage().catch((e) => ({ tool: "codex", error: e.message })),
    args.skipClaude
      ? Promise.resolve(null)
      : getClaudeUsage({ debug: args.debug }).catch((e) => ({ tool: "claude", error: e.message })),
  ]);

  const includeSpark = mentionsSpark(args.task);

  console.log(formatCompact({ codexUsage, claudeUsage, includeSpark }));
  console.log("");

  if (args.debug && claudeUsage?.debugFile) {
    console.error(`[debug] raw claude /status capture: ${claudeUsage.debugFile}`);
  }

  if (args.json) {
    console.log(JSON.stringify({ codexUsage, claudeUsage }, null, 2));
    return;
  }

  console.error("Asking agent for a recommendation...\n");

  const suggestion = await getSuggestion({
    codexUsage: codexUsage || { tool: "codex", error: "skipped" },
    claudeUsage: claudeUsage || { tool: "claude", error: "skipped" },
    task: args.task,
    via: args.via,
    model: args.model,
  });

  console.log(suggestion);
}

main().catch((err) => {
  console.error("quota-pilot failed:", err.message);
  process.exit(1);
});
