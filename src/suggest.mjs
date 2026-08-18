import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SPARK_MODEL, filterCodexUsage, mentionsSpark } from "./usageView.mjs";

function buildPrompt({ codexUsage, claudeUsage, task }) {
  const includeSpark = mentionsSpark(task);
  const codexForPrompt = filterCodexUsage(codexUsage, { includeSpark });

  const parts = [
    "You are helping a developer decide which coding CLI agent to use right now:",
    "OpenAI Codex CLI (`codex`) or Claude Code (`claude`). Both are subscription",
    "plans with rolling usage limits that reset on their own schedule.",
    "",
    "Model tiers to be aware of:",
    `- Codex's main pool (frontier models like GPT-5.6 Sol/Terra): strongest`,
    `  reasoning, use for anything non-trivial — refactors, multi-file work,`,
    `  debugging, design decisions. This is the pool with the tightest quota.`,
    "- Claude Code: separate subscription/quota, strong general coding agent.",
  ];

  if (includeSpark) {
    parts.push(
      `- "${SPARK_MODEL}" (Spark): an ultra-fast, lightweight Codex model. Only`,
      `  ever recommend it for genuinely small/quick work (one-line fixes, typo`,
      `  fixes, trivial lookups, simple boilerplate). Having full quota left is`,
      `  NOT a reason to route bigger or harder work to it — it is not a general`,
      `  substitute for the main pool, treat it as a separate cheap lane, not a`,
      `  primary recommendation.`
    );
  }

  parts.push(
    "",
    "Here is their live usage data:",
    "",
    "## Codex usage (from `codex app-server`, exact percentages)",
    "```json",
    JSON.stringify(codexForPrompt, null, 2),
    "```",
    "",
    "## Claude usage (raw captured `/status` panel text, best-effort scrape",
    "of the interactive TUI — there is no API for this, so read it as text)",
    "```",
    claudeUsage.raw || `(unavailable: ${claudeUsage.error || "unknown reason"})`,
    "```",
    ""
  );

  if (!includeSpark) {
    parts.push(
      "The Spark lane is intentionally left out of scope here — the developer",
      "didn't mention it, so don't bring it up or suggest switching to it.",
      ""
    );
  }

  if (task && task.trim()) {
    parts.push(
      "## The task the developer wants to do next",
      task.trim(),
      "",
      "Give a decisive, specific recommendation for THIS task: which CLI, and",
      "which model/tier within it. Justify using remaining headroom and reset",
      "timing on each plan. If Claude's data is unavailable, say so plainly and",
      "recommend proceeding on Codex data alone rather than hedging both ways."
    );
  } else {
    parts.push(
      "No specific task was given. The goal is pacing, not task-sizing: given how",
      "much headroom is left on each plan and when each one resets, tell the",
      "developer how to use their time between now and the next reset(s) without",
      "wasting quota or getting caught out with none left before a reset. Call out",
      `things like: which plan is at risk of running low before its reset and`,
      `should be throttled now${includeSpark ? " (Spark included as a relief valve if it helps)" : ""},`,
      "which plan has slack and can be used more freely, and whether it's worth",
      "holding off non-urgent work until a reset is close."
    );
  }

  parts.push(
    "",
    "Output format (no preamble, don't restate the raw data verbatim):",
    "1. One-line bold recommendation.",
    "2. 2-4 bullets of reasoning (headroom, burn rate implied by the data, reset timing).",
    "3. One line: concrete pacing advice for the time between now and the next",
    "   reset(s) — what to throttle, what's safe to spend freely, so nothing",
    "   goes to waste and nothing runs out early."
  );

  return parts.join("\n");
}

async function runCodexExec(prompt, { model } = {}) {
  const outFile = path.join(os.tmpdir(), `quota-pilot-${Date.now()}.txt`);
  const args = ["exec", "--output-last-message", outFile, "--skip-git-repo-check", "-s", "read-only"];
  if (model) args.push("-m", model);
  args.push(prompt);

  await new Promise((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`codex exec exited ${code}: ${err}`))));
  });

  const text = await fs.readFile(outFile, "utf8").catch(() => "");
  await fs.unlink(outFile).catch(() => {});
  return text.trim();
}

async function runClaudePrint(prompt, { model } = {}) {
  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  args.push(prompt);

  const text = await new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`claude -p exited ${code}: ${err}`))));
  });

  try {
    const parsed = JSON.parse(text);
    return (parsed.result || parsed.response || text).trim();
  } catch {
    return text.trim();
  }
}

/**
 * Asks a live agent (not a hardcoded rule) to recommend which CLI/plan to
 * use, given both usage snapshots and an optional free-text task description.
 */
export async function getSuggestion({ codexUsage, claudeUsage, task, via = "codex", model }) {
  const prompt = buildPrompt({ codexUsage, claudeUsage, task });
  if (via === "claude") return runClaudePrint(prompt, { model });
  return runCodexExec(prompt, { model });
}
