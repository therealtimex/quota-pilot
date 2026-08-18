export const SPARK_MODEL = "gpt-5.3-codex-spark";
const SPARK_LIMIT_IDS = new Set(["codex_bengalfox", "spark"]);

export function mentionsSpark(text) {
  return /\bspark\b/i.test(text || "");
}

/**
 * Spark is a separate cheap/fast Codex lane that's easy to over-recommend
 * just because it usually has full quota. Per default policy: it's excluded
 * from both the compact usage view and the suggestion prompt unless the
 * user's task text actually mentions it — so it never becomes a silent
 * default, only an explicit choice.
 */
export function filterCodexUsage(codexUsage, { includeSpark }) {
  if (!codexUsage || !Array.isArray(codexUsage.limits)) return codexUsage;
  if (includeSpark) return codexUsage;
  return {
    ...codexUsage,
    limits: codexUsage.limits.filter((l) => !SPARK_LIMIT_IDS.has(l.id)),
  };
}

// Best-effort extraction of the Usage-tab numbers from Claude's raw
// captured /status text, for the *compact* display only. The suggestion
// prompt still gets the full raw text — this is just for a quick summary,
// so a missed match here degrades to "unavailable", it never blocks anything.
function parseClaudeUsage(raw) {
  if (!raw) return [];
  const lines = raw.split("\n");
  const found = new Map(); // label -> {percent, resets}

  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].trim();
    const isSession = label === "Current session";
    const isWeek = /^Current week\b/.test(label);
    if (!isSession && !isWeek) continue;

    const pctLine = lines[i + 1] || "";
    const pctMatch = pctLine.match(/(\d{1,3})%\s*used/i);
    if (!pctMatch) continue;

    const resetsLine = (lines[i + 2] || "").trim();
    const resetsMatch = resetsLine.match(/^Resets\s+(.+)$/i);

    found.set(label, {
      label,
      percentUsed: Number(pctMatch[1]),
      resets: resetsMatch ? resetsMatch[1] : null,
    });
  }

  return [...found.values()];
}

function bar(percentUsed, width = 20) {
  const pct = Math.max(0, Math.min(100, percentUsed));
  const filled = Math.round((pct / 100) * width);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

export function formatCompact({ codexUsage, claudeUsage, includeSpark }) {
  const lines = [];

  lines.push(`Codex${codexUsage?.account?.email ? ` (${codexUsage.account.email} · ${codexUsage.account.planType})` : ""}`);
  if (!codexUsage || (codexUsage.error && !codexUsage.limits)) {
    lines.push(`  unavailable: ${codexUsage?.error || "skipped"}`);
  } else {
    const limits = filterCodexUsage(codexUsage, { includeSpark })?.limits || [];
    if (!limits.length) {
      lines.push("  no limit data");
    }
    for (const l of limits) {
      const resets = l.resetsAt ? new Date(l.resetsAt).toLocaleString() : "unknown";
      lines.push(`  ${l.name.padEnd(22)} [${bar(l.usedPercent)}] ${l.usedPercent}% used  resets ${resets}`);
    }
    if (!includeSpark && codexUsage?.limits?.some((l) => SPARK_LIMIT_IDS.has(l.id))) {
      lines.push(`  (Spark lane hidden — mention "spark" to include it)`);
    }
  }

  lines.push("");
  lines.push("Claude");
  if (!claudeUsage?.raw) {
    lines.push(`  unavailable: ${claudeUsage?.error || "no data"}`);
  } else {
    const parsed = parseClaudeUsage(claudeUsage.raw);
    if (!parsed.length) {
      lines.push("  captured /status text, but couldn't extract percentages (see --debug)");
    } else {
      for (const p of parsed) {
        lines.push(`  ${p.label.padEnd(22)} [${bar(p.percentUsed)}] ${p.percentUsed}% used${p.resets ? `  resets ${p.resets}` : ""}`);
      }
    }
  }

  return lines.join("\n");
}
