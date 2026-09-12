/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { Banner, Surface, Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { importAniListToken } from "../lib/registry";

export const Route = createFileRoute("/api/anilist/callback")({
  component: AniListCallbackPage,
});

type Capture =
  | { readonly kind: "token"; readonly accessToken: string; readonly expiresIn?: number }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" };

function readHash(): Capture {
  const raw = globalThis.location.hash.startsWith("#")
    ? globalThis.location.hash.slice(1)
    : globalThis.location.hash;
  if (!raw) {
    return { kind: "empty" };
  }
  const params = new URLSearchParams(raw);
  const error = params.get("error");
  if (error) {
    const hint = params.get("error_description") ?? params.get("message") ?? params.get("hint");
    return {
      kind: "error",
      message: hint ? `${error}: ${hint}` : error,
    };
  }
  const accessToken = params.get("access_token");
  if (!accessToken) {
    return { kind: "empty" };
  }
  const expiresRaw = params.get("expires_in");
  const expiresParsed = expiresRaw !== null ? Number(expiresRaw) : Number.NaN;
  if (Number.isFinite(expiresParsed) && expiresParsed > 0) {
    return { kind: "token", accessToken, expiresIn: expiresParsed };
  }
  return { kind: "token", accessToken };
}

function AniListCallbackPage() {
  const [status, setStatus] = useState<"working" | "ok" | "error">("working");
  const [detail, setDetail] = useState("Reading AniList token from the URL…");

  useEffect(() => {
    const capture = readHash();
    // Drop the fragment so a refresh cannot re-import the bearer.
    globalThis.history.replaceState(
      {},
      "",
      globalThis.location.pathname + globalThis.location.search,
    );

    if (capture.kind === "error") {
      // oxlint-disable-next-line react/set-state-in-effect -- one-shot OAuth return
      setStatus("error");
      setDetail(capture.message);
      return;
    }
    if (capture.kind === "empty") {
      setStatus("error");
      setDetail(
        "No access_token in the URL. Use Credentials → paste token, or try Authorize again.",
      );
      return;
    }

    void (async () => {
      try {
        if (capture.expiresIn !== undefined) {
          await importAniListToken({
            data: { accessToken: capture.accessToken, expiresIn: capture.expiresIn },
          });
        } else {
          await importAniListToken({ data: { accessToken: capture.accessToken } });
        }
        setStatus("ok");
        setDetail("AniList connected. Returning to Credentials…");
        globalThis.setTimeout(() => {
          globalThis.location.assign("/admin/credentials?oauth=connected&provider=anilist");
        }, 600);
      } catch (cause) {
        setStatus("error");
        setDetail(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, []);

  return (
    <div className="grid gap-6">
      <Text as="h1" variant="heading">
        AniList callback
      </Text>
      <Surface>
        <div className="grid gap-3 p-1">
          {status === "error" ? (
            <Banner variant="error" title="Could not connect AniList" description={detail} />
          ) : (
            <Banner
              variant="default"
              title={status === "ok" ? "Connected" : "Working"}
              description={detail}
            />
          )}
          {status === "error" && (
            <a className="text-sm underline opacity-80 hover:opacity-100" href="/admin/credentials">
              Back to Credentials
            </a>
          )}
        </div>
      </Surface>
    </div>
  );
}
