import { LayerCard, SkeletonLine, Surface, Table, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/** Shared table skeleton — mirrors DataTable's loading rows. */
export function TableSkeleton({
  columns,
  rows = 6,
}: {
  readonly columns: number;
  readonly rows?: number;
}): ReactNode {
  return (
    <div className="overflow-x-auto">
      <Table className="w-full">
        <Table.Header>
          <Table.Row>
            {Array.from({ length: columns }).map((_, index) => (
              <Table.Head key={`head-${index}`}>
                <SkeletonLine minWidth={48} maxWidth={96} blockHeight={16} className="rounded" />
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {Array.from({ length: rows }).map((_, index) => (
            <Table.Row key={`row-${index}`}>
              {Array.from({ length: columns }).map((__, cellIndex) => (
                <Table.Cell key={`cell-${index}-${cellIndex}`}>
                  <SkeletonLine minWidth={40} maxWidth={80} blockHeight={16} className="rounded" />
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

export function StatCardSkeleton(): ReactNode {
  return (
    <LayerCard className="px-5 py-4">
      <div className="grid gap-1.5">
        <SkeletonLine minWidth={72} maxWidth={140} blockHeight={16} className="rounded" />
        <SkeletonLine minWidth={48} maxWidth={96} blockHeight={24} className="rounded" />
        <SkeletonLine minWidth={100} maxWidth={180} blockHeight={14} className="rounded" />
      </div>
    </LayerCard>
  );
}

/** Meter / distribution widget skeleton for Overview cards. */
export function MeterCardSkeleton({ bars = 5 }: { readonly bars?: number }): ReactNode {
  return (
    <LayerCard className="px-5 py-4">
      <div className="grid content-start gap-3">
        <SkeletonLine minWidth={96} maxWidth={160} blockHeight={16} className="rounded" />
        {Array.from({ length: bars }).map((_, index) => (
          <div key={index} className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <SkeletonLine minWidth={48} maxWidth={96} blockHeight={14} className="rounded" />
              <SkeletonLine minWidth={24} maxWidth={40} blockHeight={14} className="rounded" />
            </div>
            <SkeletonLine minWidth={120} maxWidth={280} blockHeight={8} className="w-full rounded" />
          </div>
        ))}
      </div>
    </LayerCard>
  );
}

/** Page chrome shown while a route loader is pending or client data boots. */
export function PagePending({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h1" variant="heading">
          {title}
        </Text>
        {description !== undefined && <Text>{description}</Text>}
      </div>
      {children}
    </div>
  );
}

export function OverviewPending(): ReactNode {
  return (
    <PagePending title="Overview" description="Library and infrastructure health for manifold.jfa.dev.">
      <LibraryWidgetsSkeleton />
      <InfrastructureWidgetsSkeleton />
    </PagePending>
  );
}

export function LibraryWidgetsSkeleton(): ReactNode {
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Library
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <StatCardSkeleton key={`stat-${index}`} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <MeterCardSkeleton key={`meter-${index}`} />
        ))}
      </div>
    </div>
  );
}

export function InfrastructureWidgetsSkeleton(): ReactNode {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Infrastructure
        </Text>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <StatCardSkeleton key={`infra-${index}`} />
        ))}
      </div>
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Worker status
        </Text>
        <Surface>
          <TableSkeleton columns={5} rows={5} />
        </Surface>
      </div>
    </div>
  );
}

export function CachePending(): ReactNode {
  return (
    <PagePending
      title="Cache"
      description="Edge cache behaviour on manifold.jfa.dev over the last window."
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Surfaces
        </Text>
        <Surface>
          <TableSkeleton columns={8} />
        </Surface>
      </div>
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Cache status breakdown
        </Text>
        <Surface>
          <TableSkeleton columns={4} rows={5} />
        </Surface>
      </div>
    </PagePending>
  );
}

export function RequestsPending(): ReactNode {
  return (
    <PagePending title="Requests" description="Traffic across the router, sync API, and catalog.">
      <Surface>
        <TableSkeleton columns={6} rows={8} />
      </Surface>
    </PagePending>
  );
}

export function DurableObjectsPending(): ReactNode {
  return (
    <PagePending
      title="Durable Objects"
      description="Live instances and storage for each DO class bound to the sync worker."
    >
      <Surface>
        <TableSkeleton columns={4} rows={3} />
      </Surface>
      <div className="grid gap-1.5">
        <Text as="h2" variant="heading">
          Outbox health
        </Text>
        <Surface className="px-5 py-4">
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
        </Surface>
      </div>
    </PagePending>
  );
}

export function RegistryPending(): ReactNode {
  return (
    <PagePending
      title="Canonical registry"
      description="Provider-neutral entries with tracker bindings and list state."
    >
      <Surface>
        <TableSkeleton columns={8} rows={10} />
      </Surface>
    </PagePending>
  );
}

export function OperationsPending(): ReactNode {
  return (
    <PagePending
      title="Sync operations"
      description="Queued provider operations, registry mutation log, and on-device My Updates probe failures."
    >
      <Surface>
        <TableSkeleton columns={7} rows={8} />
      </Surface>
    </PagePending>
  );
}

export function MangaDexLibraryPending(): ReactNode {
  return (
    <PagePending
      title="MangaDex library"
      description="Followed titles cached locally. Status edits hit MangaDex immediately."
    >
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 6 }).map((_, index) => (
          <SkeletonLine
            key={index}
            minWidth={72}
            maxWidth={120}
            blockHeight={28}
            className="rounded-full"
          />
        ))}
      </div>
      <Surface>
        <TableSkeleton columns={7} rows={10} />
      </Surface>
    </PagePending>
  );
}

export function CredentialsPending(): ReactNode {
  return (
    <PagePending
      title="Credentials"
      description="Upstream tracker tokens stored on the personal Durable Object."
    >
      <Surface>
        <TableSkeleton columns={5} rows={3} />
      </Surface>
    </PagePending>
  );
}
