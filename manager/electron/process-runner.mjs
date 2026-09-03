import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;

function terminateProcessTree(child, signal = "SIGKILL") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("error", () => {
      try { child.kill(signal); } catch {}
    });
    const fallback = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(signal); } catch {}
      }
    }, 750);
    fallback.unref?.();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try { child.kill(signal); } catch {}
    }
  }
}

function createProcessError(executable, args, result) {
  const label = [executable, ...args].join(" ");
  const detail = String(result.stderr || result.stdout || "").trim();
  const reason = result.timedOut
    ? `timed out after ${result.timeoutMs} ms`
    : result.outputLimitExceeded
      ? `exceeded output limit ${result.maxBuffer} bytes`
      : `exited with code ${result.status}`;
  const error = new Error(`${label} ${reason}${detail ? `: ${detail}` : ""}`);
  error.code = result.timedOut ? "PROCESS_TIMEOUT" : result.outputLimitExceeded ? "PROCESS_OUTPUT_LIMIT" : "PROCESS_EXIT_NONZERO";
  error.status = result.status;
  error.signal = result.signal;
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  error.timedOut = result.timedOut;
  error.outputLimitExceeded = result.outputLimitExceeded;
  error.timeoutMs = result.timeoutMs;
  error.maxBuffer = result.maxBuffer;
  return error;
}

export function nonInteractiveGitEnv(extra = {}) {
  return {
    ...process.env,
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    ...extra
  };
}

export function runProcess(executable, args = [], options = {}) {
  const timeoutMs = Math.max(250, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxBuffer = Math.max(1024, Number(options.maxBuffer ?? DEFAULT_MAX_BUFFER));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let observedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const append = (current, chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      observedBytes += data.byteLength;
      const remaining = Math.max(0, maxBuffer - current.byteLength);
      if (!remaining) return current;
      return Buffer.concat([current, data.subarray(0, remaining)]);
    };
    const stop = () => terminateProcessTree(child, "SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
      if (observedBytes > maxBuffer && !outputLimitExceeded) {
        outputLimitExceeded = true;
        stop();
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
      if (observedBytes > maxBuffer && !outputLimitExceeded) {
        outputLimitExceeded = true;
        stop();
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: Number(code ?? 1),
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        outputLimitExceeded,
        timeoutMs,
        maxBuffer
      });
    });

    if (options.input !== undefined && child.stdin) child.stdin.end(options.input);
  });
}

export async function runCheckedProcess(executable, args = [], options = {}) {
  const result = await runProcess(executable, args, options);
  if (result.status !== 0 || result.timedOut || result.outputLimitExceeded) {
    throw createProcessError(executable, args, result);
  }
  return result;
}

export function runPowerShellProcess(script, options = {}) {
  return runCheckedProcess(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs: 8_000, maxBuffer: 2 * 1024 * 1024, ...options }
  );
}

export function runGitProcess(args, options = {}) {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  return runCheckedProcess(executable, args, {
    timeoutMs: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
    env: nonInteractiveGitEnv(options.env)
  });
}
