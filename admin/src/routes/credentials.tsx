/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
import { Badge, Banner, Button, Dialog, Input, Surface, Table, Text } from "@cloudflare/kumo";
import { isString, type JsonValue } from "@manifold/json";
import { XIcon } from "@phosphor-icons/react";
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
import { useRefreshingLoad } from "../lib/use-load";

type CredentialsSearch = {
  readonly oauth?: string;
  readonly provider?: string;
};

export const Route = createFileRoute("/credentials")({
  validateSearch: (search: { readonly oauth?: JsonValue; readonly provider?: JsonValue }) =>
    ({
      ...(isString(search.oauth) && { oauth: search.oauth }),
      ...(isString(search.provider) && { provider: search.provider }),
    }) satisfies CredentialsSearch,
  component: CredentialsPage,
});

const PROVIDER_LABELS: Record<AuthProvider, string> = {
  anilist: "AniList",
  mal: "MyAnimeList",
  mangadex: "MangaDex",
};

const PROVIDER_HINTS: Record<AuthProvider, string> = {
  anilist:
    "Dedicated admin app (50915, implicit). Authorize in browser, or paste a token via the dialog.",
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

type OAuthReturn = { readonly notice?: string; readonly error?: string };

/** Banner for a provider OAuth return (`?oauth=connected|denied&provider=…`). */
function oauthReturn(search: CredentialsSearch): OAuthReturn {
  const { oauth, provider } = search;

  if (!oauth || !provider) {
    return {};
  }

  const label =
    provider === "anilist" || provider === "mal" || provider === "mangadex"
      ? PROVIDER_LABELS[provider]
      : provider;

  if (oauth === "connected") {
    return { notice: `${label} connected.` };
  }

  return oauth === "denied" ? { error: `${label} authorization was denied.` } : {};
}

function CredentialsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const {
    data: connections,
    error: loadError,
    busy,
    refresh,
  } = useRefreshingLoad(loadAuthConnections);

  const [error, setError] = useState(() => oauthReturn(search).error);
  const [notice, setNotice] = useState(() => oauthReturn(search).notice);
  const [acting, setActing] = useState<string | undefined>(undefined);
  const [aniListTokenDraft, setAniListTokenDraft] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);

  // The OAuth return banner is read once into state above; drop the params so a reload doesn't repeat it.
  useEffect(() => {
    if (search.oauth !== undefined || search.provider !== undefined) {
      void navigate({ search: {}, replace: true });
    }
  }, [navigate, search.oauth, search.provider]);

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

      {loadError !== null && (
        <Banner variant="error" title="Connections unavailable" description={loadError} />
      )}
      {error !== undefined && <Banner variant="error" title="Action failed" description={error} />}
      {notice !== undefined && <Banner variant="default" title="Updated" description={notice} />}

      <Surface>
        {connections === undefined && loadError === null ? (
          <TableSkeleton columns={5} rows={3} />
        ) : connections === undefined ? (
          <p className="px-5 py-4 text-sm opacity-60">
            Connection status is unknown until the auth API responds.
          </p>
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
        <Dialog
          size="sm"
          className="w-[calc(100vw-2rem)] overflow-x-hidden overflow-y-auto p-4 sm:w-72 sm:p-6"
        >
          <div className="grid min-w-0 gap-4">
            <div className="sticky top-0 z-10 -mx-4 -mt-4 flex min-w-0 items-start gap-3 rounded-t-xl border-b border-kumo-line bg-kumo-base px-4 pt-4 pb-3 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6">
              <div className="grid min-w-0 flex-1 gap-1">
                <Dialog.Title>Paste AniList token</Dialog.Title>
                <Dialog.Description>
                  Same idea as the tracker settings field. Paste an access token from AniList, the
                  tracker, or the device page. Admin stores it encrypted on the Durable Object and
                  never calls AniList from the Worker.
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={(props) => (
                  <Button
                    {...props}
                    size="sm"
                    variant="ghost"
                    aria-label="Close"
                    className="shrink-0"
                    disabled={acting !== undefined}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </Button>
                )}
              />
            </div>
            <Input
              type="password"
              aria-label="AniList access token"
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
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <Dialog.Close
                render={(props) => (
                  <Button
                    variant="secondary"
                    {...props}
                    className="w-full sm:w-auto"
                    disabled={acting !== undefined}
                  >
                    Cancel
                  </Button>
                )}
              />
              <Button
                size="sm"
                className="w-full sm:w-auto"
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
        the browser never sees the bearer. MangaDex uses <code className="text-xs">MANGADEX_*</code>{" "}
        on the sync Worker. AniList browser login uses the dedicated admin app{" "}
        <code className="text-xs">50915</code> (implicit) →{" "}
        <code className="text-xs">/admin/api/anilist/callback</code>.
      </p>
    </div>
  );
}
