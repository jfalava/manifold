/**
 * Terminal side of the device-code login: show the user code and approval
 * URL, poll in the background, and accept o (open) / c (copy) / esc (cancel).
 * Nothing is pasted, so headless hosts behave the same as desktops.
 */
/** Raw TTY keys are Promise-based host APIs (not Effect domains). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { stdin } from "node:process";

import pc from "picocolors";

import { cliError } from "@/effect-kit";
import { canOpenBrowser, openInBrowser, tryCopyToClipboard } from "@/login/oauth-loopback";
import { createWaitView, type WaitKey } from "@/login/oauth-wait-view";
import { terminalSession } from "@/terminal-alert";
import { frameDetail, frameUrl } from "@/ui";

type RawStdin = NodeJS.ReadStream & { setRawMode: (mode: boolean) => NodeJS.ReadStream };

const isRawStdin = (stream: NodeJS.ReadStream): stream is RawStdin =>
  stream.isTTY && stream.setRawMode !== undefined;

export type DeviceWaitOptions<T> = {
  readonly providerLabel: string;
  readonly userCode: string;
  /** Approval page with the code filled in. */
  readonly url: string;
  readonly poll: (signal: AbortSignal) => Promise<T>;
};

/** Resolves with the poll result; rejects on cancel or poll failure. */
export const waitForDeviceApproval = async <T>(options: DeviceWaitOptions<T>): Promise<T> => {
  const ac = new AbortController();
  const rawStdin = isRawStdin(stdin) ? stdin : undefined;
  const cancelled = Promise.withResolvers<never>();
  let cleanup: (() => void) | undefined;

  if (rawStdin) {
    const canOpen = canOpenBrowser();
    let copyLabel = "copy URL";
    let copyTimer: ReturnType<typeof setTimeout> | undefined;

    const keys = (): WaitKey[] => [
      ...(canOpen ? [{ key: "o", label: "open browser" }] : []),
      { key: "c", label: copyLabel },
      { key: "esc", label: "cancel" },
    ];

    const view = createWaitView({
      label: `Waiting for ${options.providerLabel} approval in your browser…`,
      hint: `Check that the page shows ${pc.bold(pc.reset(options.userCode))}, then approve.`,
      url: options.url,
      keys: keys(),
    });

    const cancel = (): void => {
      terminalSession()?.cancel();
      cancelled.reject(cliError("Login cancelled."));
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");

      // Lone ESC is the Esc key; longer chunks starting with ESC are escape sequences.
      if (text === "\u001b" || text.includes("\u0003")) {
        cancel();

        return;
      }

      if (text === "c" || text === "C") {
        void tryCopyToClipboard(options.url).then((ok) => {
          copyLabel = ok ? `${pc.green("✓")} copied` : `${pc.yellow("!")} copy failed`;
          view.update({ keys: keys() });
          clearTimeout(copyTimer);
          copyTimer = setTimeout(() => {
            copyLabel = "copy URL";
            view.update({ keys: keys() });
          }, 2000);
        });
      } else if (canOpen && (text === "o" || text === "O")) {
        void openInBrowser(options.url).then((ok) => {
          view.update({
            warning: ok ? undefined : "Could not open the browser. Copy and open the URL manually.",
          });
        });
      }
    };

    rawStdin.setRawMode(true);
    rawStdin.resume();
    rawStdin.on("data", onData);

    cleanup = () => {
      clearTimeout(copyTimer);
      view.clear();
      rawStdin.removeListener("data", onData);

      try {
        rawStdin.setRawMode(false);
      } catch {
        // already non-raw
      }

      rawStdin.pause();
    };
  } else {
    frameDetail(`Open this page in any browser and approve code ${options.userCode}:`);
    frameUrl(options.url);
  }

  terminalSession()?.blocked("auth", `Approve ${options.providerLabel} sign-in in your browser`);

  try {
    return await Promise.race([options.poll(ac.signal), cancelled.promise]);
  } finally {
    ac.abort();
    cleanup?.();
    terminalSession()?.resume();
  }
};
