import { spawn, type ChildProcess } from "node:child_process";

export type ProcessRunResult = {
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
};

export type ProcessRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
  timeout?: number;
  encoding?: BufferEncoding;
  windowsHide?: boolean;
  maxBuffer?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child.pid) return;
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
    }, 1_000);
    fallback.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill(signal); } catch {}
    }
  }
}

export function nonInteractiveGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    ...extra
  };
}

export function runProcess(executable: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? options.timeout ?? DEFAULT_TIMEOUT_MS));
  const maxBuffer = Math.max(1_024, Number(options.maxBuffer ?? DEFAULT_MAX_BUFFER));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let observedBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const append = (current: Buffer, chunk: Buffer | string): Buffer => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      observedBytes += data.byteLength;
      const remaining = Math.max(0, maxBuffer - current.byteLength);
      if (remaining === 0) return current;
      return Buffer.concat([current, data.subarray(0, remaining)]);
    };
    const stop = () => terminateProcessTree(child, "SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref();

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
        outputLimitExceeded
      });
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

export function runGitProcess(root: string, args: string[], options: ProcessRunOptions = {}): Promise<ProcessRunResult> {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  return runProcess(executable, args, {
    ...options,
    cwd: root,
    env: nonInteractiveGitEnv(options.env)
  });
}
