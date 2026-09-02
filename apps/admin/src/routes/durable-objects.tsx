import { Badge, Banner, SkeletonLine, Surface, Table, Text } from "@cloudflare/kumo";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { TableSkeleton } from "../components/loading";
import { getAnalyticsSnapshot, type AnalyticsSnapshot } from "../lib/analytics";
import { getLibraryOverview, type OpsSummary } from "../lib/registry";
import { useLoad, type LoadState } from "../lib/use-load";

export const Route = createFileRoute("/durable-objects")({
  component: DurableObjectsPage,
});

const OPS_BADGES = {
  completed: "success",
  pending: "warning",
  blocked: "error",
  failed: "error",
} satisfies Record<string, "success" | "warning" | "error" | "neutral">;

function opsBadgeVariant(state: string): "success" | "warning" | "error" | "neutral" {
  return Object.entries(OPS_BADGES).find(([key]) => key === state)?.[1] ?? "neutral";
}

function DurableObjectsPage() {
  const analytics = useLoad(getAnalyticsSnapshot);
  const library = useLoad(getLibraryOverview);

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          Durable Objects
        </Text>
        <Text>Live instances and storage for each DO class bound to the sync worker.</Text>
      </div>
      {analytics.status === "error" && (
        <Banner variant="alert" title="Analytics unavailable" description={analytics.message} />
      )}
      {analytics.status === "ready" && !analytics.value.ok && (
        <Banner
          variant="alert"
          title="Analytics unavailable"
          description={analytics.value.reason ?? "Worker analytics could not be loaded."}
        />
      )}
      {library.status === "error" && (
        <Banner variant="alert" title="Outbox data unavailable" description={library.message} />
      )}

      <DoInstancesCard state={analytics} />
      <OutboxHealthCard
        state={
          library.status === "loading"
            ? { status: "loading" }
            : library.status === "error"
              ? { status: "error", message: library.message }
              : {
                  status: "ready",
                  value: library.value.ops,
                }
        }
      />
    </div>
  );
}

function DoInstancesCard({
  state,
}: {
  readonly state: LoadState<AnalyticsSnapshot>;
}): ReactNode {
  return (
    <Surface>
      {state.status === "loading" ? (
        <TableSkeleton columns={4} rows={3} />
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Class</Table.Head>
              <Table.Head>Purpose</Table.Head>
              <Table.Head>Requests (24h)</Table.Head>
              <Table.Head>Storage (7d max)</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            <Table.Row>
              <Table.Cell>ManifoldSync</Table.Cell>
              <Table.Cell>personal sync singleton</Table.Cell>
              <Table.Cell>
                {state.status === "ready" && state.value.ok
                  ? formatCount(state.value.doRequests)
                  : "—"}
              </Table.Cell>
              <Table.Cell>
                {state.status === "ready" ? formatBytes(state.value.doStoredBytes) : "—"}
              </Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table>
      )}
    </Surface>
  );
}

function OutboxHealthCard({
  state,
}: {
  readonly state: LoadState<OpsSummary | null>;
}): ReactNode {
  return (
    <div className="grid gap-1.5">
      <Text as="h2" variant="heading">
        Outbox health
      </Text>
      <Surface className="px-5 py-4">
        {state.status === "loading" && (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: 3 }).map((_, index) => (
                <SkeletonLine
                  key={index}
                  minWidth={64}
                  maxWidth={110}
                  blockHeight={24}
                  className="rounded-full"
                />
              ))}
            </div>
            <SkeletonLine minWidth={180} maxWidth={280} blockHeight={14} className="rounded" />
          </div>
        )}
        {state.status === "error" && <Badge variant="neutral">ops unavailable</Badge>}
        {state.status === "ready" && state.value === null && (
          <Badge variant="neutral">ops unavailable</Badge>
        )}
        {state.status === "ready" && state.value !== null && (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(state.value.states)
                .toSorted((a, b) => b[1] - a[1])
                .map(([stateName, count]) => (
                  <Badge key={stateName} variant={opsBadgeVariant(stateName)}>
                    {stateName} {count.toLocaleString("en")}
                  </Badge>
                ))}
              {state.value.total === 0 && <Badge variant="neutral">no recent ops</Badge>}
            </div>
            {state.value.oldestPendingAt !== null && (
              <p className="text-sm opacity-60">
                Oldest pending op since {new Date(state.value.oldestPendingAt).toLocaleString()}.
              </p>
            )}
            {state.value.lastFailedError !== null && (
              <p className="text-sm text-kumo-danger">
                Last failure: <span className="break-all">{state.value.lastFailedError}</span>
              </p>
            )}
            <Link to="/operations" className="text-sm underline opacity-60 hover:opacity-100">
              Open operations →
            </Link>
          </div>
        )}
      </Surface>
    </div>
  );
}

function formatCount(value: number): string {
  return value > 0 ? value.toLocaleString("en") : "—";
}

function formatBytes(value: number | null): string {
  if (value === null || value <= 0) {
    return "—";
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
