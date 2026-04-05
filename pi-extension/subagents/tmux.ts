import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { execSync } from "node:child_process";
import { basename } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Check if tmux is available (running inside a tmux session with the tmux binary on PATH).
 */
export function isMuxAvailable(): boolean {
  if (!process.env.TMUX) return false;
  try {
    execSync("command -v tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Generate a unique tmux session name.
 * Format: pi-<sanitized-name>-<random>
 */
function makeSessionName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const rand = Math.random().toString(36).slice(2, 6);
  return `pi-${safe || "agent"}-${rand}`;
}

/**
 * Create a new tmux session as a surface for a subagent.
 * Returns the session name (used as the surface identifier).
 */
export function createSurface(name: string): string {
  const sessionName = makeSessionName(name);

  execFileSync("tmux", [
    "new-session", "-d", "-s", sessionName,
    "-x", "200", "-y", "50",
  ], { encoding: "utf8" });

  return sessionName;
}

/**
 * Send a command string to a tmux session and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Read the screen contents of a tmux session (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a tmux session (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a tmux session.
 */
export function closeSurface(surface: string): void {
  execFileSync("tmux", ["kill-session", "-t", surface], { encoding: "utf8" });
}

/**
 * Rename the current tmux window.
 */
export function renameCurrentTab(title: string): void {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) throw new Error("TMUX_PANE not set");
  const windowId = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{window_id}"],
    { encoding: "utf8" },
  ).trim();
  execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
}

/**
 * Rename the current tmux session.
 */
export function renameWorkspace(title: string): void {
  const paneId = process.env.TMUX_PANE;
  if (!paneId) throw new Error("TMUX_PANE not set");
  const sessionId = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", paneId, "#{session_id}"],
    { encoding: "utf8" },
  ).trim();
  execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
}

/**
 * Poll a tmux session until the __SUBAGENT_DONE_N__ sentinel appears.
 * Returns the process exit code embedded in the sentinel.
 * Throws if the signal is aborted before the sentinel is found.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: { interval: number; onTick?: (elapsed: number) => void },
): Promise<number> {
  const start = Date.now();

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const screen = await readScreenAsync(surface, 5);
    const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
    if (match) {
      return parseInt(match[1], 10);
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
