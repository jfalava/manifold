/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalTimers:off */
/** @effect-diagnostics globalDate:off */
import { Banner, Surface, Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { consumeAniListAuthorize } from "../lib/anilist-authorize";
import { importAniListToken } from "../lib/registry";

// The token lives in the URL fragment, which never reaches the server: render on the client only.
export const Route = createFileRoute("/api/anilist/callback")({
  ssr: false,
  component: AniListCallbackPage,
});

const NOT_STARTED_HERE =
  "This tab did not start an AniList authorization in the last ten minutes, so the token was not imported. Use Credentials → Authorize, or paste the token there.";

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

  // A token nobody asked for from this tab is someone else's link: importing it
  // would attach their AniList account to this registry.
  if (!consumeAniListAuthorize(globalThis.sessionStorage, Date.now())) {
    return { kind: "error", message: NOT_STARTED_HERE };
  }

  const expiresRaw = params.get("expires_in");
  const expiresParsed = expiresRaw !== null ? Number(expiresRaw) : Number.NaN;

  if (Number.isFinite(expiresParsed) && expiresParsed > 0) {
    return { kind: "token", accessToken, expiresIn: expiresParsed };
  }

  return { kind: "token", accessToken };
}

const NO_TOKEN =
  "No access_token in the URL. Use Credentials → paste token, or try Authorize again.";

function initialDetail(capture: Capture): string {
  switch (capture.kind) {
    case "token":
      return "Importing the AniList token…";
    case "error":
      return capture.message;
    case "empty":
      return NO_TOKEN;
  }
}

function AniListCallbackPage() {
  const [capture] = useState(readHash);

  const [status, setStatus] = useState<"working" | "ok" | "error">(
    capture.kind === "token" ? "working" : "error",
  );

  const [detail, setDetail] = useState(() => initialDetail(capture));

  useEffect(() => {
    // Drop the fragment so a refresh cannot re-import the bearer.
    globalThis.history.replaceState(
      {},
      "",
      globalThis.location.pathname + globalThis.location.search,
    );

    if (capture.kind !== "token") {
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
  }, [capture]);

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
