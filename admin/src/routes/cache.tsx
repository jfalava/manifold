/** Admin server/route host (TanStack Start + React). */
/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalDate:off */
/** @effect-diagnostics globalFetch:off */
/** @effect-diagnostics globalConsole:off */
/** @effect-diagnostics newPromise:off */
/** @effect-diagnostics globalTimers:off */
import { Badge, Banner, LayerCard, Meter, Surface, Table, Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";

import { CachePending } from "../components/loading";
import { getCacheSnapshot } from "../lib/analytics";
import { useLoad } from "../lib/use-load";

export const Route = createFileRoute("/cache")({
  component: CachePage,
});

/** cacheStatus → badge variant; "none" is normal for worker-generated responses. */
const STATUS_BADGES = {
  hit: "success",
  stale: "success",
  revalidated: "success",
  updating: "success",
  miss: "warning",
  expired: "warning",
  none: "neutral",
  dynamic: "neutral",
  bypass: "info",
} satisfies Record<string, "success" | "warning" | "info" | "neutral">;

function statusBadgeVariant(status: string): "success" | "warning" | "info" | "neutral" {
  return Object.entries(STATUS_BADGES).find(([key]) => key === status)?.[1] ?? "neutral";
}

function CachePage() {
  const state = useLoad(getCacheSnapshot);

  if (state.status === "loading") {
    return <CachePending />;
  }

  if (state.status === "error") {
    return (
      <div className="grid gap-6">
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading">
            Cache
          </Text>
          <Text>Edge cache behaviour on manifold.jfa.dev over the last window.</Text>
        </div>
        <Banner variant="alert" title="Cache analytics unavailable" description={state.message} />
      </div>
    );
  }

  const snapshot = state.value;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          Cache
        </Text>
        <Text>
          Edge cache behaviour on manifold.jfa.dev over the last {snapshot.windowHours} hours.
        </Text>
      </div>
      {!snapshot.ok && (
        <Banner
          variant="alert"
          title="Cache analytics unavailable"
          description={snapshot.reason ?? "Zone HTTP analytics could not be loaded."}
        />
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={`Requests (${snapshot.windowHours}h)`}
          value={formatCount(snapshot.totalRequests)}
          hint="edge requests to manifold.jfa.dev"
        />
        <StatCard
          label="Cache hit ratio"
          value={ratio(snapshot.cacheHits, snapshot.cacheableRequests)}
          hint={`${formatCount(snapshot.cacheHits)} of ${formatCount(snapshot.cacheableRequests)} cacheable requests`}
        />
        <StatCard
          label="Bandwidth served"
          value={formatBytes(snapshot.totalBytes)}
          hint="edge response bytes"
        />
        <StatCard
          label="Served from cache"
          value={formatBytes(snapshot.cachedBytes)}
          hint={ratio(snapshot.cachedBytes, snapshot.totalBytes) + " of all bytes"}
        />
      </div>

      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Surfaces
        </Text>
        <Text>
          Requests bucketed by router mount — the sync API serves Paperback devices and the admin,
          the catalog serves extension bundles, and docs take the fallthrough.
        </Text>
        <Surface>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Surface</Table.Head>
                <Table.Head>Mount</Table.Head>
                <Table.Head>Requests</Table.Head>
                <Table.Head>Cache hits</Table.Head>
                <Table.Head>Misses</Table.Head>
                <Table.Head>Uncacheable</Table.Head>
                <Table.Head>Bandwidth</Table.Head>
                <Table.Head className="w-48">Hit ratio</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {snapshot.surfaces.map((surface) => {
                const cacheable = surface.hits + surface.misses;
                return (
                  <Table.Row key={surface.surface}>
                    <Table.Cell>{surface.surface}</Table.Cell>
                    <Table.Cell>
                      <code className="text-xs">{surface.pathPrefix}</code>
                    </Table.Cell>
                    <Table.Cell>{formatCount(surface.requests)}</Table.Cell>
                    <Table.Cell>{formatCount(surface.hits)}</Table.Cell>
                    <Table.Cell>{formatCount(surface.misses)}</Table.Cell>
                    <Table.Cell>{formatCount(surface.uncacheable)}</Table.Cell>
                    <Table.Cell>{formatBytes(surface.bytes)}</Table.Cell>
                    <Table.Cell>
                      {cacheable > 0 ? (
                        <Meter
                          label=""
                          value={(surface.hits / cacheable) * 100}
                          customValue={ratio(surface.hits, cacheable)}
                        />
                      ) : (
                        <span className="text-sm opacity-40">uncacheable only</span>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
              {snapshot.surfaces.length === 0 && (
                <Table.Row>
                  <Table.Cell colSpan={8}>
                    <span className="text-sm opacity-60">No requests recorded in the window.</span>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        </Surface>
      </div>

      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Cache status breakdown
        </Text>
        <Text>
          “none” is expected for worker-rendered responses (API, admin SSR); static assets should
          trend towards “hit”.
        </Text>
        <Surface>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Status</Table.Head>
                <Table.Head>Requests</Table.Head>
                <Table.Head>Share</Table.Head>
                <Table.Head>Bandwidth</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {snapshot.statuses.map((slice) => (
                <Table.Row key={slice.status}>
                  <Table.Cell>
                    <Badge variant={statusBadgeVariant(slice.status)}>{slice.status}</Badge>
                  </Table.Cell>
                  <Table.Cell>{formatCount(slice.requests)}</Table.Cell>
                  <Table.Cell>{ratio(slice.requests, snapshot.totalRequests)}</Table.Cell>
                  <Table.Cell>{formatBytes(slice.bytes)}</Table.Cell>
                </Table.Row>
              ))}
              {snapshot.statuses.length === 0 && (
                <Table.Row>
                  <Table.Cell colSpan={4}>
                    <span className="text-sm opacity-60">No requests recorded in the window.</span>
                  </Table.Cell>
                </Table.Row>
              )}
            </Table.Body>
          </Table>
        </Surface>
        {snapshot.ok && (
          <p className="text-sm opacity-60">
            Updated {new Date(snapshot.fetchedAt).toLocaleTimeString("en")} from Cloudflare zone
            analytics (adaptive sampling).
          </p>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-1.5">
        <Text as="h3">{label}</Text>
        <Text size="lg" bold>
          {value}
        </Text>
        <p className="text-sm opacity-60">{hint}</p>
      </div>
    </LayerCard>
  );
}

function formatCount(value: number): string {
  return value > 0 ? value.toLocaleString("en") : "0";
}

function ratio(part: number, whole: number): string {
  if (whole <= 0) {
    return "—";
  }
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function formatBytes(value: number): string {
  if (value <= 0) {
    return "—";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
