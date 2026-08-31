import { Badge, Banner, Surface, Table, Text } from "@cloudflare/kumo";
import { createFileRoute, Link } from "@tanstack/react-router";

import { DurableObjectsPending } from "../components/loading";
import { getAnalyticsSnapshot } from "../lib/analytics";
import { getLibraryOverview } from "../lib/registry";

export const Route = createFileRoute("/durable-objects")({
  component: DurableObjectsPage,
  pendingComponent: DurableObjectsPending,
  loader: async () => {
    const [snapshot, library] = await Promise.all([getAnalyticsSnapshot(), getLibraryOverview()]);
    return { snapshot, ops: library.ops };
  },
  staleTime: 60_000,
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
  const { snapshot, ops } = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          Durable Objects
        </Text>
        <Text>Live instances and storage for each DO class bound to the sync worker.</Text>
      </div>
      {!snapshot.ok && (
        <Banner
          variant="alert"
          title="Analytics unavailable"
          description={snapshot.reason ?? "Worker analytics could not be loaded."}
        />
      )}
      <Surface>
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
              <Table.Cell>{snapshot.ok ? formatCount(snapshot.doRequests) : "—"}</Table.Cell>
              <Table.Cell>{formatBytes(snapshot.doStoredBytes)}</Table.Cell>
            </Table.Row>
          </Table.Body>
        </Table>
      </Surface>
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Outbox health
        </Text>
        <Surface className="px-5 py-4">
          {ops === null ? (
            <Badge variant="neutral">ops unavailable</Badge>
          ) : (
            <div className="grid gap-3">
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
                  Oldest pending op since {new Date(ops.oldestPendingAt).toLocaleString()}.
                </p>
              )}
              {ops.lastFailedError !== null && (
                <p className="text-sm text-kumo-danger">
                  Last failure: <span className="break-all">{ops.lastFailedError}</span>
                </p>
              )}
              <Link to="/operations" className="text-sm underline opacity-60 hover:opacity-100">
                Open operations →
              </Link>
            </div>
          )}
        </Surface>
      </div>
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
