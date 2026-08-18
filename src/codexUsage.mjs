import { spawn } from "node:child_process";
import readline from "node:readline";

/**
 * Talks to `codex app-server` over its JSON-RPC/stdio protocol to read the
 * same account + rate-limit data the interactive `/status` panel shows.
 */
export async function getCodexUsage({ timeoutMs = 10000 } = {}) {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = readline.createInterface({ input: child.stdout });

  let nextId = 1;
  const pending = new Map();
  let stderrBuf = "";
  child.stderr.on("data", (d) => (stderrBuf += d.toString()));

  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`codex app-server timed out after ${timeoutMs}ms: ${stderrBuf}`)), timeoutMs)
  );

  try {
    await Promise.race([
      send("initialize", {
        clientInfo: { name: "quota-pilot", title: "quota-pilot", version: "0.1.0" },
      }),
      timeout,
    ]);

    const [account, rateLimits] = await Promise.race([
      Promise.all([send("account/read", {}), send("account/rateLimits/read", {})]),
      timeout,
    ]);

    return normalizeCodexUsage(account, rateLimits);
  } finally {
    child.kill();
  }
}

function normalizeCodexUsage(account, rateLimits) {
  const byId = rateLimits.rateLimitsByLimitId || {};
  const limits = Object.values(byId).map((snap) => ({
    id: snap.limitId,
    name: snap.limitName || snap.limitId,
    usedPercent: snap.primary?.usedPercent ?? null,
    remainingPercent: snap.primary ? 100 - snap.primary.usedPercent : null,
    resetsAt: snap.primary?.resetsAt ? new Date(snap.primary.resetsAt * 1000).toISOString() : null,
    windowDurationMins: snap.primary?.windowDurationMins ?? null,
  }));

  return {
    tool: "codex",
    account: {
      email: account.account?.email ?? null,
      planType: account.account?.planType ?? null,
    },
    limits,
    fetchedAt: new Date().toISOString(),
  };
}
