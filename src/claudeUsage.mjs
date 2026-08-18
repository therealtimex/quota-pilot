import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Built from \uXXXX escapes (not literal bytes) so this source file stays plain text.
const ANSI_RE = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g"
);

function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}

// Opens its own pty pair (pty.openpty) and spawns `claude` attached to it,
// then drives it directly — deliberately NOT relying on `script`, which
// copies terminal attributes from *our* controlling terminal via tcgetattr
// and breaks with "Operation not supported on socket" whenever the
// invoking process's stdin isn't a plain tty device (this happens even in
// normal-looking terminal sessions depending on what's in front of them).
// Python's pty module tolerates a non-tty parent stdin fine, so this works
// regardless of what's driving this Node process.
const PY_SCRIPT = `
import os, pty, select, struct, subprocess, sys, time, fcntl, termios, signal

master_fd, slave_fd = pty.openpty()
try:
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
except OSError:
    pass

proc = subprocess.Popen(
    ["claude"],
    stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
    preexec_fn=os.setsid,
    close_fds=True,
)
os.close(slave_fd)

buf = bytearray()

def drain(timeout_s):
    end = time.time() + timeout_s
    while time.time() < end:
        remaining = end - time.time()
        r, _, _ = select.select([master_fd], [], [], max(0, remaining))
        if master_fd in r:
            try:
                chunk = os.read(master_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)

BOOT_S = float(os.environ.get("AGENT_PLAN_USAGE_BOOT_S", "4.5"))
STATUS_S = float(os.environ.get("AGENT_PLAN_USAGE_STATUS_S", "2.5"))
NAV_S = float(os.environ.get("AGENT_PLAN_USAGE_NAV_S", "1.5"))

drain(BOOT_S)
try:
    os.write(master_fd, b"/status\\r")
except OSError:
    pass
drain(STATUS_S)

# The /status panel opens on the "Status" tab (Settings, Status, Config,
# Usage, Stats). The weekly-limit percentages live under "Usage", two tabs
# to the right, so step there with the arrow keys before capturing.
for _ in range(2):
    try:
        os.write(master_fd, b"\\x1b[C")
    except OSError:
        pass
    drain(NAV_S)

try:
    os.write(master_fd, b"\\x03\\x03")
except OSError:
    pass
drain(1)

try:
    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
except (ProcessLookupError, OSError):
    pass

sys.stdout.buffer.write(bytes(buf))
sys.stdout.flush()
`;

/**
 * Claude Code has no JSON-RPC/CLI endpoint that exposes the weekly-limit
 * percentages shown in the interactive `/status` panel (unlike Codex's
 * `account/rateLimits/read`). The only way to get the real numbers is to
 * drive the TUI itself: spawn `claude` attached to a freshly-opened pty
 * (via a small Python helper, see PY_SCRIPT above), send `/status`, and
 * capture the rendered panel text.
 *
 * This is inherently best-effort: it depends on Claude Code's TUI output
 * and can fail if that changes, if the run directory isn't already
 * trusted, or if startup is slow. Callers should treat a null/failed
 * result as "unknown" rather than fatal — the raw captured text is handed
 * to the suggestion agent as-is instead of being regex-parsed into fields.
 */
export async function getClaudeUsage({ cwd = process.cwd(), timeoutMs = 20000, debug = false } = {}) {
  const python = await findPython();
  if (!python) {
    return {
      tool: "claude",
      raw: null,
      error: "no python3/python interpreter found on PATH (needed to open a pty for the claude TUI)",
      fetchedAt: new Date().toISOString(),
    };
  }

  const bootS = 4.5;
  const statusS = 5;
  const child = spawn(python, ["-c", PY_SCRIPT], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      AGENT_PLAN_USAGE_BOOT_S: String(bootS),
      AGENT_PLAN_USAGE_STATUS_S: String(statusS),
    },
  });

  let buf = Buffer.alloc(0);
  let stderrText = "";
  child.stdout.on("data", (d) => (buf = Buffer.concat([buf, d])));
  child.stderr.on("data", (d) => (stderrText += d.toString()));

  const exitCode = await new Promise((resolve) => {
    const hardTimeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(hardTimeout);
      resolve(code);
    });
    child.on("error", () => {
      clearTimeout(hardTimeout);
      resolve(null);
    });
  });

  const text = buf.toString("utf8");
  const result = fromCapture(
    text,
    exitCode === 0 ? null : `pty helper exited ${exitCode === null ? "(timed out/killed)" : exitCode}${stderrText ? `: ${stderrText.trim()}` : ""}`
  );

  if (debug) {
    result.debugFile = await dumpDebug(text);
  }

  return result;
}

let cachedPython;
async function findPython() {
  if (cachedPython !== undefined) return cachedPython;
  for (const candidate of ["python3", "python"]) {
    const ok = await new Promise((resolve) => {
      const p = spawn(candidate, ["--version"], { stdio: "ignore" });
      p.on("exit", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    });
    if (ok) {
      cachedPython = candidate;
      return candidate;
    }
  }
  cachedPython = null;
  return null;
}

async function dumpDebug(text) {
  const file = path.join(os.tmpdir(), `quota-pilot-claude-debug-${randomUUID()}.log`);
  await fs.writeFile(file, text, "utf8").catch(() => {});
  return file;
}

// Row transitions in Claude Code's TUI happen via cursor-addressing escape
// codes (CR + "move down", or absolute "go to row N"), not literal "\n". If
// those get stripped along with the rest of the ANSI codes without being
// replaced by something, whole screens' worth of visually-separate rows
// collapse into a single unreadable line. So: turn the row-transition
// sequences into real newlines *before* stripping everything else.
const ROW_BREAK_RE = new RegExp("[\\u001B\\u009B]\\[(?:\\d+;\\d+)?H|[\\u001B\\u009B]\\[\\d*[BE]", "g");

function toLines(buf) {
  const withBreaks = buf.replace(/\r/g, "\n").replace(ROW_BREAK_RE, "\n");
  return stripAnsi(withBreaks)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

function fromCapture(buf, error) {
  // The capture spans several full-screen redraws (boot screen, Status tab,
  // then Config/Usage tabs as we arrow through them) concatenated in order.
  // Rather than try to guess which redraw is "the" one, hand all of it to
  // the suggestion agent — it can find the Usage-tab numbers itself, same
  // as it already has to interpret this text without a fixed schema.
  const lines = toLines(buf);
  const text = lines.join("\n");

  return {
    tool: "claude",
    raw: text || null,
    error: text ? error : error || "no output captured",
    fetchedAt: new Date().toISOString(),
  };
}
