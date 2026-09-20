/**
 * Shared authorization-code capture for CLI provider login.
 *
 * Desktop: local loopback callback (Alchemy-style happy path).
 * Headless / remote browser: print the authorize URL, press `c` to copy it,
 * Enter to paste a code or full callback URL. Loopback and paste race.
 *
 * Token exchange stays in the caller so PKCE verifiers never leave the process.
 */
/** OAuth loopback + raw TTY keys are Promise-based host APIs (not Effect domains). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { errorMessage } from "@manifold/json";

import { cliError, envString } from "@/effect-kit";
import { frameDetail, frameUrl, muted } from "@/ui";

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : cliError(errorMessage(cause));

const DEFAULT_TIMEOUT_MS = 300_000;

export type OAuthCallbackInput = {
  readonly code: string;
  readonly state: string | null;
  readonly denied: boolean;
};

/**
 * Accept a bare code, `code#state`, or a full callback URL
 * (`http://127.0.0.1:…/callback?code=…&state=…`).
 */
export const parseOAuthCallbackInput = (raw: string): OAuthCallbackInput => {
  const value = raw.trim();
  if (!value) {
    throw cliError("Paste an authorization code or the full callback URL.");
  }

  try {
    const url = new URL(value);
    if (url.searchParams.has("error")) {
      return {
        code: "",
        state: url.searchParams.get("state"),
        denied: true,
      };
    }
    return {
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state"),
      denied: false,
    };
  } catch {
    // Not a URL — bare code or code#state (Alchemy hosted-relay paste form).
  }

  const separator = value.lastIndexOf("#");
  if (separator >= 0) {
    return {
      code: value.slice(0, separator).trim(),
      state: value.slice(separator + 1).trim() || null,
      denied: false,
    };
  }

  return { code: value, state: null, denied: false };
};

/** Validate paste/loopback input against the authorize request's state. */
export const resolveOAuthAuthorizationCode = (
  raw: string,
  expectedState: string,
  providerLabel: string,
): string => {
  const parsed = parseOAuthCallbackInput(raw);
  if (parsed.denied) {
    throw cliError(`${providerLabel} authorization denied.`);
  }
  if (!parsed.code) {
    throw cliError("Paste an authorization code or the full callback URL.");
  }
  if (parsed.state !== null && parsed.state !== expectedState) {
    throw cliError("OAuth state does not match this login attempt. Start login again.");
  }
  return parsed.code;
};

/** OSC 52 clipboard write (works over SSH when the client allows it). */
const writeOsc52Clipboard = (text: string): boolean => {
  if (!stdout.isTTY) {
    return false;
  }
  try {
    const payload = Buffer.from(text, "utf8").toString("base64");
    let sequence = `\u001b]52;c;${payload}\u0007`;
    // tmux needs a DCS passthrough wrapper to forward OSC 52 to the outer client.
    if (envString("TMUX") !== undefined) {
      sequence = `\u001bPtmux;\u001b${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
    }
    stdout.write(sequence);
    return true;
  } catch {
    return false;
  }
};

export const tryCopyToClipboard = async (text: string): Promise<boolean> => {
  // Prefer OSC 52 so SSH/headless sessions can copy without host clipboard tools.
  const osc = writeOsc52Clipboard(text);

  const write = async (command: string[], payload: string): Promise<boolean> => {
    try {
      const proc = Bun.spawn(command, {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.stdin.write(payload);
      await proc.stdin.end();
      const code = await proc.exited;
      return code === 0;
    } catch {
      return false;
    }
  };

  let tool = false;
  if (process.platform === "darwin") {
    tool = await write(["pbcopy"], text);
  } else if (process.platform === "win32") {
    tool = await write(["clip"], text);
  } else if (await write(["wl-copy"], text)) {
    tool = true;
  } else {
    tool = await write(["xclip", "-selection", "clipboard"], text);
  }

  // OSC 52 has no ack; treat either path as success so we do not spam failures.
  return osc || tool;
};

type LoopbackServer = {
  readonly stop: (closeActiveConnections?: boolean) => Promise<void>;
};

export type AwaitOAuthAuthorizationCodeOptions = {
  readonly providerLabel: string;
  readonly authorizeUrl: string;
  readonly redirectUri: string;
  readonly expectedState: string;
  /** Skip binding the loopback port; paste only (headless / port busy). */
  readonly pasteOnly?: boolean;
  readonly timeoutMs?: number;
};

const readPasteLine = async (signal: AbortSignal): Promise<string> => {
  if (signal.aborted) {
    throw cliError("Login cancelled.");
  }
  stdout.write(`${muted("│")}\n${muted("│")}  Paste authorization code or callback URL: `);
  const reader = createInterface({ input: stdin, output: stdout });
  const onAbort = (): void => {
    reader.close();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const line = await reader.question("");
    return line;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.close();
  }
};

/**
 * TTY waiter: raw-mode keys until Enter opens paste, or abort.
 * `c` copies the authorize URL; Ctrl+C cancels.
 */
type RawStdin = NodeJS.ReadStream & {
  setRawMode: (mode: boolean) => NodeJS.ReadStream;
};

const asRawStdin = (stream: NodeJS.ReadStream): RawStdin | undefined => {
  if (!stream.isTTY) {
    return undefined;
  }
  // SAFETY: Node TTY streams expose setRawMode; non-TTY already returned above.
  const candidate: NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => NodeJS.ReadStream;
  } = stream;
  if (candidate.setRawMode === undefined) {
    return undefined;
  }
  // SAFETY: setRawMode presence checked above; RawStdin requires that method.
  return candidate as RawStdin;
};

const BRACKETED_PASTE_ENABLE = "\u001b[?2004h";
const BRACKETED_PASTE_DISABLE = "\u001b[?2004l";
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * True when a raw-mode data chunk is a bulk paste (not a single key or CSI).
 * Used so OAuth codes containing `c` do not fire the copy keybind.
 */
export const isBulkPasteChunk = (text: string): boolean => {
  if (text.length <= 1 || text.startsWith("\u001b")) {
    return false;
  }
  return text.replace(/[\r\n]+$/g, "").length > 1;
};

/**
 * Drain raw TTY input: single-key commands, bracketed paste, or bulk paste.
 * Multi-byte pastes must not be interpreted key-by-key (every `c` in an OAuth
 * code used to fire the copy bind).
 */
const waitForPasteOrKey = async (
  authorizeUrl: string,
  signal: AbortSignal,
): Promise<string> => {
  const rawStdin = asRawStdin(stdin);
  if (!rawStdin) {
    return readPasteLine(signal);
  }

  frameDetail("Keys: c copy authorize URL · Enter paste code/URL · Ctrl+C cancel");

  return await new Promise<string>((resolve, reject) => {
    let cleaned = false;
    let buffer = "";
    let inBracketedPaste = false;
    let copyBusy = false;

    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      rawStdin.removeListener("data", onData);
      signal.removeEventListener("abort", onAbort);
      try {
        stdout.write(BRACKETED_PASTE_DISABLE);
      } catch {
        // ignore
      }
      try {
        rawStdin.setRawMode(false);
      } catch {
        // already non-raw
      }
      rawStdin.pause();
    };

    const fail = (cause: Error): void => {
      cleanup();
      reject(cause);
    };

    const succeed = (raw: string): void => {
      cleanup();
      resolve(raw);
    };

    const onAbort = (): void => {
      fail(cliError("Login cancelled."));
    };

    const copyAuthorizeUrl = (): void => {
      if (copyBusy || signal.aborted) {
        return;
      }
      copyBusy = true;
      void tryCopyToClipboard(authorizeUrl).then((ok) => {
        copyBusy = false;
        if (signal.aborted) {
          return;
        }
        frameDetail(
          ok
            ? "Authorize URL copied to the clipboard."
            : "Could not copy to clipboard. Select the printed URL above, or install wl-copy/xclip.",
        );
      });
    };

    const consumeBuffer = (): void => {
      while (buffer.length > 0 && !cleaned) {
        if (inBracketedPaste) {
          const end = buffer.indexOf(BRACKETED_PASTE_END);
          if (end < 0) {
            return;
          }
          const pasted = buffer.slice(0, end);
          buffer = buffer.slice(end + BRACKETED_PASTE_END.length);
          inBracketedPaste = false;
          succeed(pasted);
          return;
        }

        if (buffer.startsWith(BRACKETED_PASTE_START)) {
          buffer = buffer.slice(BRACKETED_PASTE_START.length);
          inBracketedPaste = true;
          continue;
        }

        // Incomplete CSI / OSC escape — wait for more bytes.
        if (buffer.startsWith("\u001b")) {
          if (buffer.length === 1) {
            return;
          }
          // Drop unknown short escapes; keep waiting if it might still grow into paste start.
          if (BRACKETED_PASTE_START.startsWith(buffer) || buffer.length < 6) {
            return;
          }
          buffer = buffer.slice(1);
          continue;
        }

        const ch = buffer[0]!;
        buffer = buffer.slice(1);

        if (ch === "\u0003") {
          fail(cliError("Login cancelled."));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          void readPasteLine(signal).then(resolve, (cause: unknown) => fail(asError(cause)));
          return;
        }
        if (ch === "c" || ch === "C") {
          copyAuthorizeUrl();
        }
        // Ignore other single keys.
      }
    };

    const onData = (chunk: Buffer): void => {
      if (signal.aborted || cleaned) {
        return;
      }
      const text = chunk.toString("utf8");
      // Terminals without bracketed paste often deliver the whole paste in one
      // multi-byte chunk. Treat that as the callback payload, not keybinds.
      if (!inBracketedPaste && buffer.length === 0 && isBulkPasteChunk(text)) {
        succeed(text.replace(/[\r\n]+$/g, ""));
        return;
      }
      buffer += text;
      consumeBuffer();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    rawStdin.setRawMode(true);
    rawStdin.resume();
    try {
      stdout.write(BRACKETED_PASTE_ENABLE);
    } catch {
      // ignore
    }
    rawStdin.on("data", onData);

    if (signal.aborted) {
      onAbort();
    }
  });
};

/**
 * Race loopback callback against an optional paste prompt.
 * Returns the authorization code (not yet exchanged).
 */
export const awaitOAuthAuthorizationCode = async (
  options: AwaitOAuthAuthorizationCodeOptions,
): Promise<string> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redirect = new URL(options.redirectUri);
  const port = redirect.port
    ? Number(redirect.port)
    : redirect.protocol === "https:"
      ? 443
      : 80;
  const hostname = redirect.hostname || "127.0.0.1";
  const pathname = redirect.pathname || "/callback";

  const ac = new AbortController();
  const { signal } = ac;

  const codeGate = Promise.withResolvers<string>();
  let settled = false;
  const settleResolve = (code: string): void => {
    if (settled) {
      return;
    }
    settled = true;
    ac.abort();
    codeGate.resolve(code);
  };
  const settleReject = (cause: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    ac.abort();
    codeGate.reject(cause);
  };

  let server: LoopbackServer | undefined;
  let pasteOnly = options.pasteOnly === true;

  if (!pasteOnly) {
    try {
      server = Bun.serve({
        hostname,
        port,
        fetch(request: Request) {
          const url = new URL(request.url);
          const headers = { "content-type": "text/plain", "cache-control": "no-store" };
          if (request.method !== "GET" || url.pathname !== pathname) {
            return new Response("Not found", { status: 404, headers });
          }
          try {
            const code = resolveOAuthAuthorizationCode(
              url.href,
              options.expectedState,
              options.providerLabel,
            );
            settleResolve(code);
            return new Response(
              "Authorization received. Return to the CLI to check the result.",
              { headers },
            );
          } catch (cause) {
            const failure = asError(cause);
            if (failure.message.includes("denied")) {
              settleReject(failure);
              return new Response("Authorization denied. Return to the CLI.", { headers });
            }
            return new Response(failure.message, { status: 400, headers });
          }
        },
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      frameDetail(
        `Could not bind ${options.redirectUri} (${detail}). Continuing with paste-only login.`,
      );
      pasteOnly = true;
    }
  }

  frameDetail(`Callback URL: ${options.redirectUri}`);
  frameDetail("Open this URL in your browser (click if your terminal supports links):");
  frameUrl(options.authorizeUrl);

  if (pasteOnly && !stdin.isTTY) {
    await server?.stop(true);
    throw cliError(
      `${options.providerLabel} login needs a TTY to paste the callback when loopback is disabled.`,
    );
  }

  if (pasteOnly) {
    frameDetail(
      "Paste-only mode: authorize in another browser, then press Enter and paste the callback URL or code.",
    );
  } else if (!stdin.isTTY) {
    frameDetail(
      "No TTY for paste; waiting on the local callback. Use --paste-only on a headless host.",
    );
  } else {
    frameDetail("Waiting for browser callback, or press Enter to paste a code/URL.");
  }

  const minutes = Math.round(timeoutMs / 60_000);
  const timeoutId = setTimeout(() => {
    settleReject(
      cliError(`${options.providerLabel} login timed out after ${minutes} minutes.`),
    );
  }, timeoutMs);
  // Do not keep the process alive solely for the timer once login finishes.
  timeoutId.unref?.();

  if (stdin.isTTY) {
    void waitForPasteOrKey(options.authorizeUrl, signal)
      .then((raw) => {
        if (settled) {
          return;
        }
        settleResolve(
          resolveOAuthAuthorizationCode(raw, options.expectedState, options.providerLabel),
        );
      })
      .catch((cause: unknown) => {
        if (!settled) {
          settleReject(asError(cause));
        }
      });
  }

  try {
    return await codeGate.promise;
  } finally {
    // Always cancel the timer first — awaiting a live 5‑minute sleep hung paste login.
    clearTimeout(timeoutId);
    if (!signal.aborted) {
      ac.abort();
    }
    await server?.stop(true);
  }
};
