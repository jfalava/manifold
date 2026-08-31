import { Banner, Empty, Surface, Table, Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";

import { RequestsPending } from "../components/loading";
import { getAnalyticsSnapshot, type LogicalWorker } from "../lib/analytics";

export const Route = createFileRoute("/requests")({
  component: RequestsPage,
  pendingComponent: RequestsPending,
  loader: () => getAnalyticsSnapshot(),
  staleTime: 60_000,
});

const workerOrder: LogicalWorker[] = [
  "ManifoldRouter",
  "ManifoldApi",
  "ManifoldDocs",
  "manifold-admin",
];

function RequestsPage() {
  const snapshot = Route.useLoaderData();

  const hours = Array.from(
    new Set(workerOrder.flatMap((worker) => snapshot.hourly[worker].map((point) => point.hour))),
  ).toSorted((a, b) => b.localeCompare(a));

  const totals = workerOrder.map((worker) =>
    snapshot.hourly[worker].reduce(
      (acc, point) => ({
        requests: acc.requests + point.requests,
        errors: acc.errors + point.errors,
      }),
      { requests: 0, errors: 0 },
    ),
  );

  const hasData = hours.length > 0;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          Requests
        </Text>
        <Text>Traffic across the router, sync API, and catalog.</Text>
      </div>
      {!snapshot.ok && (
        <Banner
          variant="alert"
          title="Analytics unavailable"
          description={snapshot.reason ?? "Worker analytics could not be loaded."}
        />
      )}
      {snapshot.ok && !hasData && (
        <Surface className="px-5 py-10">
          <Empty
            title="No request data yet"
            description="No invocations recorded for the df stack in the last 24 hours."
          />
        </Surface>
      )}
      {hasData && (
        <Surface>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Hour (UTC)</Table.Head>
                {workerOrder.map((worker) => (
                  <Table.Head key={worker}>{worker}</Table.Head>
                ))}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              <Table.Row>
                <Table.Cell>
                  <span className="font-medium">Total (24h)</span>
                </Table.Cell>
                {workerOrder.map((worker, index) => {
                  const total = totals[index] ?? { requests: 0, errors: 0 };
                  return (
                    <Table.Cell key={worker}>
                      <span className="font-medium tabular-nums">
                        {total.requests > 0 ? total.requests.toLocaleString("en") : "—"}
                      </span>
                      <ErrorCount errors={total.errors} />
                    </Table.Cell>
                  );
                })}
              </Table.Row>
              {hours.map((hour) => (
                <Table.Row key={hour}>
                  <Table.Cell>{hour.slice(11, 16)}:00</Table.Cell>
                  {workerOrder.map((worker) => {
                    const point = snapshot.hourly[worker].find((p) => p.hour === hour);
                    return (
                      <Table.Cell key={worker}>
                        <span className="tabular-nums">
                          {point && point.requests > 0 ? point.requests.toLocaleString("en") : "—"}
                        </span>
                        <ErrorCount errors={point?.errors ?? 0} />
                      </Table.Cell>
                    );
                  })}
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Surface>
      )}
      {hasData && (
        <p className="text-sm opacity-60">
          Error counts appear in red next to the request count for that hour.
        </p>
      )}
    </div>
  );
}

function ErrorCount({ errors }: { errors: number }) {
  if (errors <= 0) {
    return null;
  }
  return (
    <span className="ml-1.5 text-xs text-kumo-danger tabular-nums">
      {errors.toLocaleString("en")} err
    </span>
  );
}
