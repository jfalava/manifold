import { Badge, Banner, LayerCard, Meter, Table, Text } from "@cloudflare/kumo";
import { createFileRoute, Link } from "@tanstack/react-router";

import { OverviewPending } from "../components/loading";
import { getAnalyticsSnapshot, WORKER_CATALOG } from "../lib/analytics";
import {
  getLibraryOverview,
  TRACKER_PROVIDERS,
  type MangaDexSummary,
  type OpsSummary,
  type RegistrySummary,
} from "../lib/registry";

export const Route = createFileRoute("/")({
  component: OverviewPage,
  pendingComponent: OverviewPending,
  loader: async () => {
    const [snapshot, library] = await Promise.all([getAnalyticsSnapshot(), getLibraryOverview()]);
    return { snapshot, library };
  },
  // The server fns are cached (KV + stale-while-revalidate); keep loader
  // data warm client-side too so tab hops don't refetch.
  staleTime: 60_000,
});

/** Fixed display order for list-status distributions; unknown keys follow. */
const STATUS_ORDER = [
  "reading",
  "re_reading",
  "completed",
  "on_hold",
  "plan_to_read",
  "dropped",
  "unset",
] as const;

function orderedStatuses(statuses: Record<string, number>): [string, number][] {
  const known = new Set<string>(STATUS_ORDER);
  const rest = Object.entries(statuses)
    .filter(([status]) => !known.has(status))
    .toSorted((a, b) => b[1] - a[1]);
  return [
    ...STATUS_ORDER.flatMap<[string, number]>((status) =>
      status in statuses ? [[status, statuses[status] ?? 0]] : [],
    ),
    ...rest,
  ];
}

function OverviewPage() {
  const { snapshot, library } = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          Overview
        </Text>
        <Text>Library and infrastructure health for manifold.jfa.dev.</Text>
      </div>
      {!snapshot.ok && (
        <Banner
          variant="alert"
          title="Analytics unavailable"
          description={snapshot.reason ?? "Worker analytics could not be loaded."}
        />
      )}
      {library.errors.length > 0 && (
        <Banner
          variant="alert"
          title="Library data incomplete"
          description={library.errors.join(" · ")}
        />
      )}

      <LibrarySection registry={library.registry} ops={library.ops} mangadex={library.mangadex} />

      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Infrastructure
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label="Workers"
          value={String(WORKER_CATALOG.length)}
          hint="deployed workers and sites"
        />
        <StatCard
          label="Requests (24h)"
          value={formatCount(snapshot.totalRequests)}
          hint={`${snapshot.totalErrors.toLocaleString("en")} errors across the df stack`}
        />
        <StatCard
          label="Durable Object requests (24h)"
          value={formatCount(snapshot.doRequests)}
          hint="ManifoldSync namespace"
        />
      </div>
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Worker status
        </Text>
        <LayerCard>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Worker</Table.Head>
                <Table.Head>Kind</Table.Head>
                <Table.Head>Health</Table.Head>
                <Table.Head>Requests (24h)</Table.Head>
                <Table.Head>Errors (24h)</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {WORKER_CATALOG.map((worker) => {
                const traffic = snapshot.workerTraffic[worker.logical];
                return (
                  <Table.Row key={worker.logical}>
                    <Table.Cell>{worker.logical}</Table.Cell>
                    <Table.Cell>{worker.kind}</Table.Cell>
                    <Table.Cell>
                      <Badge variant={healthVariant(traffic)}>{healthLabel(traffic)}</Badge>
                    </Table.Cell>
                    <Table.Cell>{traffic ? formatCount(traffic.requests) : "—"}</Table.Cell>
                    <Table.Cell>{traffic ? formatCount(traffic.errors) : "—"}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </LayerCard>
        {snapshot.ok && (
          <p className="text-sm opacity-60">
            Updated {new Date(snapshot.fetchedAt).toLocaleTimeString("en")} from Cloudflare GraphQL
            analytics.
          </p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Library widgets
// ------------------------------------------------------------------

function LibrarySection({
  registry,
  ops,
  mangadex,
}: {
  registry: RegistrySummary | null;
  ops: OpsSummary | null;
  mangadex: MangaDexSummary | null;
}) {
  const attention = ops
    ? (ops.states.pending ?? 0) + (ops.states.blocked ?? 0) + (ops.states.failed ?? 0)
    : 0;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Library
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Registry entries"
          value={registry ? registry.active.toLocaleString("en") : "—"}
          hint={registry ? `${registry.tombstoned.toLocaleString("en")} tombstoned` : "unavailable"}
          to="/registry"
        />
        <StatCard
          label="Full tracker coverage"
          value={
            registry && registry.active > 0 ? percent(registry.fullyLinked, registry.active) : "—"
          }
          hint={
            registry
              ? `${registry.fullyLinked.toLocaleString("en")} entries on all ${TRACKER_PROVIDERS.length} trackers`
              : "unavailable"
          }
          to="/registry"
        />
        <StatCard
          label="MangaDex library"
          value={mangadex ? mangadex.total.toLocaleString("en") : "—"}
          hint={
            mangadex
              ? `${mangadex.linkedToRegistry.toLocaleString("en")} resolved to registry entries`
              : "unavailable"
          }
          to="/mangadex-library"
        />
        <StatCard
          label="Ops needing attention"
          value={ops ? attention.toLocaleString("en") : "—"}
          hint={ops ? `of ${ops.total.toLocaleString("en")} recent operations` : "unavailable"}
          to="/operations"
        />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <DistributionCard
          title="Registry status"
          entries={registry ? orderedStatuses(registry.statuses) : []}
          total={registry?.active ?? 0}
          emptyText="Registry unavailable."
        />
        <ProviderCoverageCard registry={registry} />
        <DistributionCard
          title="MangaDex shelf"
          entries={mangadex ? orderedStatuses(mangadex.statuses) : []}
          total={mangadex?.total ?? 0}
          emptyText="MangaDex library unavailable."
          footer={
            mangadex && mangadex.rated > 0
              ? `${mangadex.rated.toLocaleString("en")} rated · mean ${(mangadex.meanRating ?? 0).toFixed(1)}/10`
              : undefined
          }
        />
        <OpsHealthCard ops={ops} />
      </div>
    </div>
  );
}

function DistributionCard({
  title,
  entries,
  total,
  emptyText,
  footer,
}: {
  title: string;
  entries: readonly [string, number][];
  total: number;
  emptyText: string;
  footer?: string;
}) {
  return (
    <LayerCard className="px-5 py-4">
      <div className="grid content-start gap-3">
        <Text as="h3" bold>
          {title}
        </Text>
        {entries.length === 0 && <p className="text-sm opacity-60">{emptyText}</p>}
        {entries.map(([label, count]) => (
          <Meter
            key={label}
            label={label.replaceAll("_", " ")}
            value={total > 0 ? (count / total) * 100 : 0}
            customValue={count.toLocaleString("en")}
          />
        ))}
        {footer !== undefined && <p className="text-sm opacity-60">{footer}</p>}
      </div>
    </LayerCard>
  );
}

function ProviderCoverageCard({ registry }: { registry: RegistrySummary | null }) {
  const providers = registry
    ? [...new Set([...TRACKER_PROVIDERS, ...Object.keys(registry.providerCounts)])]
    : [];
  return (
    <LayerCard className="px-5 py-4">
      <div className="grid content-start gap-3">
        <Text as="h3" bold>
          Provider coverage
        </Text>
        {!registry && <p className="text-sm opacity-60">Registry unavailable.</p>}
        {registry &&
          providers.map((provider) => {
            const linked = registry.providerCounts[provider] ?? 0;
            return (
              <Meter
                key={provider}
                label={provider}
                value={registry.active > 0 ? (linked / registry.active) * 100 : 0}
                customValue={`${linked.toLocaleString("en")} / ${registry.active.toLocaleString("en")}`}
              />
            );
          })}
        {registry && registry.unlinked > 0 && (
          <p className="text-sm text-kumo-danger">
            {registry.unlinked.toLocaleString("en")} entries have no provider links.
          </p>
        )}
      </div>
    </LayerCard>
  );
}

const OPS_BADGES = {
  completed: "success",
  pending: "warning",
  blocked: "error",
  failed: "error",
} satisfies Record<string, "success" | "warning" | "error" | "neutral">;

function opsBadgeVariant(state: string): "success" | "warning" | "error" | "neutral" {
  return Object.entries(OPS_BADGES).find(([key]) => key === state)?.[1] ?? "neutral";
}

function OpsHealthCard({ ops }: { ops: OpsSummary | null }) {
  return (
    <LayerCard className="px-5 py-4">
      <div className="grid content-start gap-3">
        <Text as="h3" bold>
          Sync outbox
        </Text>
        {!ops && <p className="text-sm opacity-60">Operations unavailable.</p>}
        {ops && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(ops.states)
                .toSorted((a, b) => b[1] - a[1])
                .map(([state, count]) => (
                  <Badge key={state} variant={opsBadgeVariant(state)}>
                    {state} {count.toLocaleString("en")}
                  </Badge>
                ))}
              {ops.total === 0 && <Badge variant="neutral">no recent ops</Badge>}
            </div>
            {ops.oldestPendingAt !== null && (
              <p className="text-sm opacity-60">
                Oldest pending since {new Date(ops.oldestPendingAt).toLocaleString()}
              </p>
            )}
            {ops.lastFailedError !== null && (
              <p className="text-sm text-kumo-danger" title={ops.lastFailedError}>
                Last failure: <span className="break-all">{ops.lastFailedError}</span>
              </p>
            )}
            <Link to="/operations" className="text-sm underline opacity-60 hover:opacity-100">
              Open operations →
            </Link>
          </>
        )}
      </div>
    </LayerCard>
  );
}

function StatCard({
  label,
  value,
  hint,
  to,
}: {
  label: string;
  value: string;
  hint: string;
  to?: "/registry" | "/mangadex-library" | "/operations";
}) {
  const body = (
    <div className="grid gap-1.5">
      <Text as="h3">{label}</Text>
      <Text size="lg" bold>
        {value}
      </Text>
      <p className="text-sm opacity-60">{hint}</p>
    </div>
  );
  return (
    <LayerCard className="px-5 py-4">
      {to === undefined ? body : <Link to={to}>{body}</Link>}
    </LayerCard>
  );
}

function healthVariant(
  traffic: { requests: number; errors: number } | undefined,
): "success" | "warning" | "neutral" {
  if (!traffic || traffic.requests === 0) {
    return "neutral";
  }
  return traffic.errors / traffic.requests < 0.01 ? "success" : "warning";
}

function healthLabel(traffic: { requests: number; errors: number } | undefined): string {
  if (!traffic || traffic.requests === 0) {
    return "no traffic";
  }
  return traffic.errors / traffic.requests < 0.01 ? "healthy" : "degraded";
}

function formatCount(value: number): string {
  return value > 0 ? value.toLocaleString("en") : "—";
}

function percent(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(0)}%`;
}
