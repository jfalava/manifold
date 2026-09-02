import { Badge, Banner, Button, Dialog, Input, Surface, Table, Text } from "@cloudflare/kumo";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { TableSkeleton } from "../components/loading";
import {
  anilistImplicitAuthorizeUrl,
  AUTH_PROVIDERS,
  disconnectAuth,
  importAniListToken,
  loadAuthConnections,
  loginMangaDex,
  startMalOAuth,
  type AuthConnection,
  type AuthProvider,
} from "../lib/registry";

export const Route = createFileRoute("/credentials")({
  component: CredentialsPage,
});

const PROVIDER_LABELS: Record<AuthProvider, string> = {
  anilist: "AniList",
  mal: "MyAnimeList",
  mangadex: "MangaDex",
};

const PROVIDER_HINTS: Record<AuthProvider, string> = {
  anilist:
    "Same client as the Paperback tracker (49218, implicit). Authorize in browser, or paste a token via the dialog.",
  mal: "Browser OAuth code flow. Connect uses the admin MANIFOLD_TOKEN binding; callback stores tokens on the personal Durable Object.",
  mangadex:
    "Personal-client password grant. Deployment secrets (MANGADEX_*) mint tokens into the Durable Object — env alone is not a connection.",
};

function formatWhen(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
  return new Date(ms).toLocaleString();
}

type HashTokenCapture = {
  readonly accessToken?: string;
  readonly expiresIn?: number;
  readonly error?: string;
};

function parseHashToken(hash: string): HashTokenCapture {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) {
    return {};
  }
  const params = new URLSearchParams(raw);
  const error = params.get("error");
  const accessToken = params.get("access_token");
  const expiresRaw = params.get("expires_in");
  const expiresParsed = expiresRaw !== null ? Number(expiresRaw) : Number.NaN;
  const expiresIn = Number.isFinite(expiresParsed) && expiresParsed > 0 ? expiresParsed : undefined;
  if (accessToken && expiresIn !== undefined && error) {
    return { accessToken, expiresIn, error };
  }
  if (accessToken && expiresIn !== undefined) {
    return { accessToken, expiresIn };
  }
  if (accessToken && error) {
    return { accessToken, error };
  }
  if (accessToken) {
    return { accessToken };
  }
  if (error) {
    return { error };
  }
  return {};
}

function CredentialsPage() {
  const [connections, setConnections] = useState<readonly AuthConnection[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | undefined>(undefined);
  const [aniListTokenDraft, setAniListTokenDraft] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setConnections(await loadAuthConnections());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount syncs with the auth API
    void refresh();
  }, [refresh]);

  // MAL code-flow return (?oauth=…) and AniList implicit return (#access_token=…).
  useEffect(() => {
    const params = new URLSearchParams(globalThis.location.search);
    const oauth = params.get("oauth");
    const provider = params.get("provider");
    if (oauth && provider) {
      const label =
        provider === "anilist" || provider === "mal" || provider === "mangadex"
          ? PROVIDER_LABELS[provider]
          : provider;
      if (oauth === "connected") {
        // oxlint-disable-next-line react/set-state-in-effect -- one-shot query banner after OAuth return
        setNotice(`${label} connected.`);
      } else if (oauth === "denied") {
        // oxlint-disable-next-line react/set-state-in-effect -- one-shot query banner after OAuth return
        setError(`${label} authorization was denied.`);
      }
      const next = new URL(globalThis.location.href);
      next.searchParams.delete("oauth");
      next.searchParams.delete("provider");
      globalThis.history.replaceState({}, "", next.pathname + next.search + next.hash);
    }

    const hash = globalThis.location.hash;
    const captured = parseHashToken(hash);
    if (!captured.accessToken && !captured.error) {
      return;
    }
    // Drop the fragment immediately so a refresh cannot re-import.
    globalThis.history.replaceState(
      {},
      "",
      globalThis.location.pathname + globalThis.location.search,
    );
    if (captured.error) {
      // oxlint-disable-next-line react/set-state-in-effect -- one-shot hash banner after OAuth return
      setError(`AniList authorization failed: ${captured.error}`);
      return;
    }
    const hashToken = captured.accessToken;
    if (!hashToken) {
      return;
    }
    const hashExpiresIn = captured.expiresIn;
    void (async () => {
      setActing("login:anilist");
      setError(undefined);
      setNotice(undefined);
      try {
        if (hashExpiresIn !== undefined) {
          await importAniListToken({
            data: { accessToken: hashToken, expiresIn: hashExpiresIn },
          });
        } else {
          await importAniListToken({ data: { accessToken: hashToken } });
        }
        setNotice("AniList connected from browser token.");
        setAniListTokenDraft("");
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setActing(undefined);
      }
    })();
  }, [refresh]);

  const byProvider = new Map<AuthProvider, AuthConnection>(
    (connections ?? []).map((row) => [row.provider, row]),
  );

  const act = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setActing(key);
      setError(undefined);
      setNotice(undefined);
      try {
        await action();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setActing(undefined);
      }
    },
    [refresh],
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          Credentials
        </Text>
        <Text>
          Upstream tracker tokens stored on the personal Durable Object. MangaDex uses deployment
          secrets; MAL uses browser OAuth; AniList needs a browser-minted token pasted in (Worker
          IPs are blocked on AniList's token endpoint).
        </Text>
      </div>

      {error !== undefined && <Banner variant="error" title="Action failed" description={error} />}
      {notice !== undefined && <Banner variant="default" title="Updated" description={notice} />}

      <Surface>
        {connections === undefined && busy ? (
          <TableSkeleton columns={5} rows={3} />
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Provider</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head>Expires</Table.Head>
                <Table.Head>Updated</Table.Head>
                <Table.Head>Actions</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {AUTH_PROVIDERS.map((provider) => {
                const row = byProvider.get(provider);
                const connected = row?.connected === true;
                const connecting = acting === `login:${provider}`;
                const disconnecting = acting === `disconnect:${provider}`;
                return (
                  <Table.Row key={provider}>
                    <Table.Cell>
                      <div className="grid gap-0.5">
                        <span className="font-medium">{PROVIDER_LABELS[provider]}</span>
                        <span className="text-sm opacity-60">{PROVIDER_HINTS[provider]}</span>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge variant={connected ? "success" : "warning"}>
                        {connected ? "connected" : "disconnected"}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>{formatWhen(row?.expiresAt)}</Table.Cell>
                    <Table.Cell>{formatWhen(row?.updatedAt)}</Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-wrap gap-2">
                        {provider === "mangadex" && (
                          <Button
                            size="sm"
                            disabled={busy || acting !== undefined}
                            onClick={() =>
                              void act(`login:${provider}`, async () => {
                                const next = await loginMangaDex();
                                setNotice(
                                  next.connected
                                    ? "MangaDex connected from deployment secrets."
                                    : "MangaDex login returned disconnected.",
                                );
                              })
                            }
                          >
                            {connecting
                              ? "Connecting…"
                              : connected
                                ? "Reconnect"
                                : "Connect from secrets"}
                          </Button>
                        )}
                        {provider === "mal" && (
                          <Button
                            size="sm"
                            disabled={busy || acting !== undefined}
                            onClick={() =>
                              void act(`login:${provider}`, async () => {
                                const start = await startMalOAuth();
                                globalThis.location.assign(start.authorizationUrl);
                              })
                            }
                          >
                            {connecting ? "Redirecting…" : connected ? "Reconnect" : "Connect"}
                          </Button>
                        )}
                        {provider === "anilist" && (
                          <>
                            <Button
                              size="sm"
                              disabled={busy || acting !== undefined}
                              onClick={() => {
                                // Same-tab so return to /admin/api/anilist/callback can import the hash.
                                globalThis.location.assign(anilistImplicitAuthorizeUrl());
                              }}
                            >
                              {connected ? "Re-authorize" : "Authorize"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy || acting !== undefined}
                              onClick={() => setPasteOpen(true)}
                            >
                              Paste token
                            </Button>
                          </>
                        )}
                        {connected && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || acting !== undefined}
                            onClick={() =>
                              void act(`disconnect:${provider}`, async () => {
                                await disconnectAuth({ data: { provider } });
                                setNotice(`${PROVIDER_LABELS[provider]} disconnected.`);
                              })
                            }
                          >
                            {disconnecting ? "Disconnecting…" : "Disconnect"}
                          </Button>
                        )}
                        {provider === "mangadex" && connected && (
                          <Link
                            to="/mangadex-library"
                            className="self-center text-sm underline opacity-60 hover:opacity-100"
                          >
                            Open library →
                          </Link>
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
      </Surface>

      <Dialog.Root
        open={pasteOpen}
        onOpenChange={(open) => {
          setPasteOpen(open);
          if (!open) {
            setAniListTokenDraft("");
          }
        }}
      >
        <Dialog size="sm" className="p-6">
          <div className="grid gap-4">
            <div className="grid gap-1">
              <Dialog.Title>Paste AniList token</Dialog.Title>
              <Dialog.Description>
                Same idea as the tracker settings field. Paste an access token from AniList, the
                tracker, or the device page. Admin stores it encrypted on the Durable Object and
                never calls AniList from the Worker.
              </Dialog.Description>
            </div>
            <Input
              type="password"
              autoComplete="off"
              placeholder="AniList access token"
              value={aniListTokenDraft}
              disabled={busy || acting !== undefined}
              onChange={(event) => setAniListTokenDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || aniListTokenDraft.trim().length === 0) {
                  return;
                }
                event.preventDefault();
                void act("login:anilist", async () => {
                  await importAniListToken({ data: { accessToken: aniListTokenDraft } });
                  setAniListTokenDraft("");
                  setPasteOpen(false);
                  setNotice("AniList token saved.");
                });
              }}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close
                render={(props) => (
                  <Button variant="secondary" {...props} disabled={acting !== undefined}>
                    Cancel
                  </Button>
                )}
              />
              <Button
                size="sm"
                disabled={busy || acting !== undefined || aniListTokenDraft.trim().length === 0}
                onClick={() =>
                  void act("login:anilist", async () => {
                    await importAniListToken({ data: { accessToken: aniListTokenDraft } });
                    setAniListTokenDraft("");
                    setPasteOpen(false);
                    setNotice("AniList token saved.");
                  })
                }
              >
                {acting === "login:anilist" ? "Saving…" : "Save token"}
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <p className="text-sm opacity-60">
        Admin holds <code className="text-xs">MANIFOLD_TOKEN</code> (Secrets Store) for API calls —
        the browser never sees the bearer. MangaDex uses{" "}
        <code className="text-xs">MANGADEX_*</code> on the sync Worker. AniList uses client{" "}
        <code className="text-xs">49218</code> (implicit) →{" "}
        <code className="text-xs">/admin/api/anilist/callback</code>.
      </p>
    </div>
  );
}
