import { Badge, Banner, Button, Surface, Table, Text } from "@cloudflare/kumo";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { TableSkeleton } from "../components/loading";
import {
  AUTH_PROVIDERS,
  disconnectAuth,
  loadAuthConnections,
  loginMangaDex,
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
  anilist: "Browser OAuth via GET /v1/auth/anilist/start (Paperback / device flows).",
  mal: "Browser OAuth via GET /v1/auth/mal/start.",
  mangadex:
    "Personal-client password grant. Deployment secrets (MANGADEX_*) mint tokens into the Durable Object — env alone is not a connection.",
};

function formatWhen(ms: number | undefined): string {
  if (ms === undefined) {
    return "—";
  }
  return new Date(ms).toLocaleString();
}

function CredentialsPage() {
  const [connections, setConnections] = useState<readonly AuthConnection[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState<string | undefined>(undefined);

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
          Upstream tracker tokens stored on the personal Durable Object. MangaDex uses the
          registered personal client plus deployment secrets; calling Connect runs the password
          grant once and keeps only encrypted access/refresh tokens.
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
                      {provider !== "mangadex" && !connected && (
                        <span className="text-sm opacity-60">
                          Start OAuth from the Paperback tracker or API{" "}
                          <code className="text-xs">/v1/auth/{provider}/start</code>.
                        </span>
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

      <p className="text-sm opacity-60">
        Secrets live in <code className="text-xs">iac/.env</code> (
        <code className="text-xs">MANGADEX_CLIENT_ID</code> +{" "}
        <code className="text-xs">ALCHEMY_SECRET_MANGADEX_*</code>) and are bound to the sync Worker
        only. The admin panel never receives the username or password — Connect just triggers{" "}
        <code className="text-xs">POST /v1/auth/mangadex/login</code>.
      </p>
    </div>
  );
}
