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
import { stdin, stderr } from "node:process";
import { createInterface } from "node:readline/promises";

import { errorMessage } from "@manifold/json";
import pc from "picocolors";

import { cliError, envString } from "@/effect-kit";
import { frameDetail, frameUrl } from "@/ui";
import { createWaitView, type WaitKey } from "@/login/oauth-wait-view";
import { terminalSession } from "@/terminal-alert";
import { renderCallbackPage, type CallbackPageState } from "@/login/oauth-pages";

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
  if (!stderr.isTTY) {
    return false;
  }

  try {
    const payload = Buffer.from(text, "utf8").toString("base64");
    let sequence = `\u001b]52;c;${payload}\u0007`;

    // tmux needs a DCS passthrough wrapper to forward OSC 52 to the outer client.
    if (envString("TMUX") !== undefined) {
      sequence = `\u001bPtmux;\u001b${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
    }

    stderr.write(sequence);

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

/** SSH sessions run the browser on another machine. */
const isRemoteSession = (): boolean =>
  envString("SSH_CONNECTION") !== undefined || envString("SSH_TTY") !== undefined;

/** `o` is offered only where a local browser can plausibly open. */
const canOpenBrowser = (): boolean => {
  if (isRemoteSession()) {
    return false;
  }

  if (process.platform === "darwin" || process.platform === "win32") {
    return true;
  }

  return envString("DISPLAY") !== undefined || envString("WAYLAND_DISPLAY") !== undefined;
};

const OPEN_COMMANDS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ["open"],
  win32: ["cmd", "/c", "start", ""],
};

const openInBrowser = async (url: string): Promise<boolean> => {
  const command = [...(OPEN_COMMANDS[process.platform] ?? ["xdg-open"]), url];

  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

    return (await proc.exited) === 0;
  } catch {
    return false;
  }
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

type LoopbackRequestOptions = {
  readonly pathname: string;
  readonly expectedState: string;
  readonly providerLabel: string;
  readonly onCode: (code: string) => void;
  readonly onError: (error: Error) => void;
};

/** Browser callbacks require state; bare codes remain supported by the paste flow. */
export const handleLoopbackRequest = (
  request: Request,
  options: LoopbackRequestOptions,
): Response => {
  const url = new URL(request.url);

  if (request.method !== "GET" || url.pathname !== options.pathname) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const page = (state: CallbackPageState, status = 200): Response =>
    new Response(renderCallbackPage(state, options.providerLabel), {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });

  if (url.searchParams.get("state") !== options.expectedState) {
    return page("state-mismatch", 400);
  }

  if (url.searchParams.has("error")) {
    const denied = url.searchParams.get("error") === "access_denied";
    options.onError(
      cliError(
        denied
          ? `${options.providerLabel} authorization denied.`
          : `${options.providerLabel} authorization failed. Start login again.`,
      ),
    );

    return page(denied ? "declined" : "provider-error");
  }

  const code = url.searchParams.get("code");

  if (!code) {
    return page("missing-code", 400);
  }

  options.onCode(code);

  return page("received");
};

const readPasteLine = async (signal: AbortSignal): Promise<string> => {
  if (signal.aborted) {
    throw cliError("Login cancelled.");
  }

  const reader = createInterface({ input: stdin, output: stderr });

  const onAbort = (): void => {
    reader.close();
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    // readline redraws its own prompt line, so a separately written prompt is wiped.
    const line = await reader.question("  󰌗 Paste authorization code or callback URL: ");

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

const isRawStdin = (stream: NodeJS.ReadStream): stream is RawStdin =>
  stream.isTTY && stream.setRawMode !== undefined;

const asRawStdin = (stream: NodeJS.ReadStream): RawStdin | undefined =>
  isRawStdin(stream) ? stream : undefined;

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
type WaitOptions = {
  readonly authorizeUrl: string;
  readonly label: string;
  readonly hint: string | undefined;
};

const waitForPasteOrKey = async (
  rawStdin: RawStdin,
  options: WaitOptions,
  signal: AbortSignal,
): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    let cleaned = false;
    let buffer = "";
    let inBracketedPaste = false;
    let copyBusy = false;
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    const canOpen = canOpenBrowser();
    let copyLabel = "copy URL";

    const keys = (): WaitKey[] => [
      { key: "enter", label: "paste code" },
      ...(canOpen ? [{ key: "o", label: "open browser" }] : []),
      { key: "c", label: copyLabel },
      { key: "esc", label: "cancel" },
    ];

    const view = createWaitView({
      label: options.label,
      url: options.authorizeUrl,
      hint: options.hint,
      keys: keys(),
    });

    const cleanup = (): void => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      clearTimeout(copyTimer);
      view.clear();
      rawStdin.removeListener("data", onData);
      signal.removeEventListener("abort", onAbort);

      try {
        stderr.write(BRACKETED_PASTE_DISABLE);
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
      void tryCopyToClipboard(options.authorizeUrl).then((ok) => {
        copyBusy = false;

        if (cleaned) {
          return;
        }

        copyLabel = ok ? `${pc.green("✓")} copied` : `${pc.yellow("!")} copy failed`;
        view.update({
          keys: keys(),
          warning: ok
            ? undefined
            : "Could not copy. Select the URL above, or install wl-copy/xclip.",
        });
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          copyLabel = "copy URL";
          view.update({ keys: keys() });
        }, 2000);
      });
    };

    const openAuthorizeUrl = (): void => {
      void openInBrowser(options.authorizeUrl).then((ok) => {
        if (!cleaned) {
          view.update({
            warning: ok ? undefined : "Could not open the browser. Copy and open the URL manually.",
          });
        }
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

        const ch = buffer.charAt(0);
        buffer = buffer.slice(1);

        if (ch === "\u0003") {
          terminalSession()?.cancel();
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
        } else if (canOpen && (ch === "o" || ch === "O")) {
          openAuthorizeUrl();
        }
        // Ignore other single keys.
      }
    };

    const onData = (chunk: Buffer): void => {
      if (signal.aborted || cleaned) {
        return;
      }

      const text = chunk.toString("utf8");

      // A lone ESC chunk is the Esc key; escape sequences arrive with their tail.
      if (text === "\u001b" && buffer.length === 0 && !inBracketedPaste) {
        terminalSession()?.cancel();
        fail(cliError("Login cancelled."));

        return;
      }

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
      stderr.write(BRACKETED_PASTE_ENABLE);
    } catch {
      // ignore
    }

    rawStdin.on("data", onData);

    if (signal.aborted) {
      onAbort();
    }
  });

/**
 * Race loopback callback against an optional paste prompt.
 * Returns the authorization code (not yet exchanged).
 */
export const awaitOAuthAuthorizationCode = async (
  options: AwaitOAuthAuthorizationCodeOptions,
): Promise<string> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redirect = new URL(options.redirectUri);
  const port = redirect.port ? Number(redirect.port) : redirect.protocol === "https:" ? 443 : 80;
  const hostname = redirect.hostname || "127.0.0.1";
  const pathname = redirect.pathname || "/callback";

  const ac = new AbortController();
  const { signal } = ac;

  const codeGate = Promise.withResolvers<string>();
  let settled = false;
  let settledByCallback = false;

  const settleResolve = (code: string, fromCallback = false): void => {
    if (settled) {
      return;
    }

    settled = true;
    settledByCallback = fromCallback;
    ac.abort();
    codeGate.resolve(code);
  };

  const settleReject = (cause: Error, fromCallback = false): void => {
    if (settled) {
      return;
    }

    settled = true;
    settledByCallback = fromCallback;
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
          return handleLoopbackRequest(request, {
            pathname,
            expectedState: options.expectedState,
            providerLabel: options.providerLabel,
            onCode: (code) => settleResolve(code, true),
            onError: (error) => settleReject(error, true),
          });
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

  if (pasteOnly && !stdin.isTTY) {
    await server?.stop(true);
    throw cliError(
      `${options.providerLabel} login needs a TTY to paste the callback when loopback is disabled.`,
    );
  }

  const minutes = Math.round(timeoutMs / 60_000);

  const timeoutId = setTimeout(() => {
    settleReject(cliError(`${options.providerLabel} login timed out after ${minutes} minutes.`));
  }, timeoutMs);

  // Do not keep the process alive solely for the timer once login finishes.
  timeoutId.unref?.();

  const pasteHint = `Authorize in any browser, then press enter and paste the ${options.redirectUri}?… URL or the code.`;
  const rawStdin = asRawStdin(stdin);

  if (!rawStdin) {
    frameDetail("Open in your browser:");
    frameUrl(options.authorizeUrl);

    if (pasteOnly) {
      frameDetail(`Paste-only: ${pasteHint}`);
    } else if (!stdin.isTTY) {
      frameDetail(
        "No TTY for paste; waiting on the local callback. Use --paste-only on a headless host.",
      );
    } else {
      frameDetail("Waiting for the browser. Press Enter to paste a code or callback URL.");
    }
  }

  const waiting = rawStdin
    ? waitForPasteOrKey(
        rawStdin,
        {
          authorizeUrl: options.authorizeUrl,
          label: pasteOnly
            ? "Waiting for a pasted callback URL or code…"
            : `Waiting for ${options.providerLabel} authorization (up to ${minutes} minutes)…`,
          // Over SSH the browser runs elsewhere, so the loopback cannot see its redirect.
          hint: pasteOnly || isRemoteSession() ? pasteHint : undefined,
        },
        signal,
      )
    : stdin.isTTY
      ? readPasteLine(signal)
      : undefined;

  if (waiting) {
    void waiting
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

  terminalSession()?.blocked("auth", `Authorize ${options.providerLabel} in your browser`);

  try {
    return await codeGate.promise;
  } finally {
    terminalSession()?.resume();
    // Always cancel the timer first — awaiting a live 5‑minute sleep hung paste login.
    clearTimeout(timeoutId);

    if (!signal.aborted) {
      ac.abort();
    }

    // Drain terminal callbacks; paste and timeout still close active connections immediately.
    await server?.stop(!settledByCallback);
  }
};
