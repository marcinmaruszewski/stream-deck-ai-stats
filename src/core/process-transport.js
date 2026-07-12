import { spawn as nodeSpawn } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Creates the short-lived process boundary used by provider adapters.
 *
 * Commands are always spawned without a shell.  On Windows, `mode: "wsl"`
 * starts the selected distribution through wsl.exe; native Windows and macOS
 * start the provider CLI directly.
 */
export function createPlatformProcessTransport({
  platform = process.platform,
  mode = "native",
  executableOverrides = {},
  environment = {},
  inheritedEnv = process.env,
  wsl = {},
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  spawn = nodeSpawn,
  readFile = nodeReadFile,
} = {}) {
  validateConfiguration({ platform, mode, executableOverrides, environment, inheritedEnv, wsl, defaultTimeoutMs, spawn, readFile });
  const activeChildren = new Set();
  const execute = (command) => {
    const invocation = commandFor({ platform, mode, executableOverrides, environment, inheritedEnv, wsl, command });
    return runProcess({ ...invocation, timeoutMs: command.timeoutMs ?? defaultTimeoutMs, signal: command.signal, onStdout: command.onStdout, spawn, activeChildren });
  };

  return Object.freeze({
    execute,
    async readFile(path) {
      if (!nonEmptyString(path)) throw new Error("ProcessTransport snapshot path must be a path");
      if (mode !== "wsl") return readFile(path, "utf8");
      const result = await execute({ executable: "cat", args: [path] });
      if (result.exitCode !== 0) throw new ProcessTransportError("Unable to read WSL usage snapshot");
      return result.stdout;
    },
    async recover() {
      await Promise.all([...activeChildren].map((child) => terminate(child)));
    },
  });
}

function validateConfiguration({ platform, mode, executableOverrides, environment, inheritedEnv, wsl, defaultTimeoutMs, spawn, readFile }) {
  if (!supportedPlatform(platform)) throw new Error("ProcessTransport supports Windows and macOS only");
  if (mode !== "native" && mode !== "wsl") throw new Error("ProcessTransport mode must be native or wsl");
  if (mode === "wsl" && platform !== "win32") throw new Error("WSL ProcessTransport requires Windows");
  if (mode === "wsl" && !nonEmptyString(wsl.distribution)) throw new Error("WSL ProcessTransport requires a distribution");
  if (!objectLike(executableOverrides) || !objectLike(environment) || !objectLike(inheritedEnv)
    || (wsl.environment !== undefined && !objectLike(wsl.environment))
    || (wsl.hostEnvironment !== undefined && !objectLike(wsl.hostEnvironment))) {
    throw new Error("ProcessTransport environments must be objects");
  }
  if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) throw new Error("ProcessTransport timeout must be positive");
  if (typeof spawn !== "function") throw new Error("ProcessTransport requires a spawn function");
  if (typeof readFile !== "function") throw new Error("ProcessTransport requires a snapshot reader");
}

function commandFor({ platform, mode, executableOverrides, environment, inheritedEnv, wsl, command }) {
  if (!objectLike(command) || !nonEmptyString(command.executable)) throw new Error("ProcessTransport command requires an executable");
  if (command.args !== undefined && !Array.isArray(command.args)) throw new Error("ProcessTransport command arguments must be an array");
  if (command.args?.some((argument) => typeof argument !== "string")) throw new Error("ProcessTransport command arguments must be strings");
  if (command.cwd !== undefined && !nonEmptyString(command.cwd)) throw new Error("ProcessTransport command working directory must be a path");
  if (command.input !== undefined && typeof command.input !== "string" && !Buffer.isBuffer(command.input)) {
    throw new Error("ProcessTransport command input must be text or a Buffer");
  }
  if (command.onStdout !== undefined && typeof command.onStdout !== "function") {
    throw new Error("ProcessTransport stdout callback must be a function");
  }

  const executable = executableOverrides[command.executable] ?? command.executable;
  const args = command.args ?? [];
  if (mode === "wsl") {
    const wslExecutable = executableOverrides.wsl ?? "wsl.exe";
    const wslEnvironment = { ...wsl.environment, ...environment };
    return {
      executable: wslExecutable,
      args: [
        "--distribution", wsl.distribution,
        ...(command.cwd ? ["--cd", command.cwd] : []),
        ...environmentArguments(wslEnvironment),
        "--exec", executable,
        ...args,
      ],
      options: { cwd: wsl.hostCwd, env: { ...inheritedEnv, ...wsl.hostEnvironment }, windowsHide: true, shell: false },
      input: command.input,
    };
  }

  return {
    executable,
    args,
    options: { cwd: command.cwd, env: { ...inheritedEnv, ...environment }, windowsHide: platform === "win32", shell: false },
    input: command.input,
  };
}

function environmentArguments(environment) {
  return Object.entries(environment).flatMap(([name, value]) => {
    if (!nonEmptyString(name) || typeof value !== "string") throw new Error("ProcessTransport environment entries must be string pairs");
    return ["--env", `${name}=${value}`];
  });
}

function runProcess({ executable, args, options, input, timeoutMs, signal, onStdout, spawn, activeChildren }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("ProcessTransport command timeout must be positive"));
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timeout;
    let cancellation;
    const stdout = [];
    const stderr = [];

    const finish = (outcome, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancellation);
      activeChildren.delete(child);
      outcome(value);
    };

    try {
      child = spawn(executable, args, options);
      activeChildren.add(child);
      child.stdout?.on("data", (chunk) => {
        const text = Buffer.from(chunk);
        stdout.push(text);
        onStdout?.(text);
      });
      child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => finish(reject, new ProcessTransportError(`Unable to start ${executable}`, { cause: error })));
      child.once("close", (exitCode, exitSignal) => finish(resolve, {
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
      cancellation = () => {
        void terminate(child);
        finish(reject, abortError());
      };
      signal?.addEventListener("abort", cancellation, { once: true });
      timeout = setTimeout(() => {
        void terminate(child);
        finish(reject, new ProcessTimeoutError(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (commandInput(child, input)) return;
    } catch (error) {
      finish(reject, error instanceof Error ? error : new Error("Unable to start process"));
    }
  });
}

function commandInput(child, input) {
  if (input === undefined || !child.stdin) return false;
  child.stdin.end(input);
  return true;
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    child.once?.("close", resolve);
    child.kill?.();
    setTimeout(resolve, 1_000).unref?.();
  });
}

function supportedPlatform(platform) {
  return platform === "win32" || platform === "darwin";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function objectLike(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError() {
  return new DOMException("Process execution was cancelled", "AbortError");
}

export class ProcessTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessTimeoutError";
  }
}

export class ProcessTransportError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProcessTransportError";
  }
}
