import { appendEvent, readEntry } from "./sql-helpers";
import type { SyncHost } from "./host";
import { now } from "./constants";
import { newId } from "../effect-host";
import type {
  RegistryEntry,
  IngestCandidateInput,
  LinkProviderInput,
  ResolveEntryInput,
} from "../domain";
import { type ProviderRow } from "../sync-rows";

export async function resolveEntry(
  host: SyncHost,
  input: ResolveEntryInput,
): Promise<RegistryEntry> {
  return resolveEntrySync(host, input);
}

export async function resolveEntries(
  host: SyncHost,
  input: readonly ResolveEntryInput[] | ResolveEntryInput,
): Promise<readonly RegistryEntry[]> {
  const requests = Array.isArray(input) ? input : [input];
  return requests.map((request) => resolveEntrySync(host, request));
}

export async function ingestCandidate(
  host: SyncHost,
  input: IngestCandidateInput,
): Promise<RegistryEntry> {
  const byProvider = new Map<string, LinkProviderInput>();
  for (const link of [
    {
      provider: input.provider,
      externalId: input.providerId,
      title: input.title,
    },
    ...(input.links ?? []),
  ]) {
    const existing = byProvider.get(link.provider);
    if (existing && existing.externalId !== link.externalId) {
      throw new Error(
        `Registry candidate has conflicting ${link.provider} ids: ` +
          `${existing.externalId} and ${link.externalId}`,
      );
    }
    byProvider.set(link.provider, link);
  }
  const links = [...byProvider.values()];
  const matchingEntryIds = new Set<string>();
  for (const link of links) {
    for (const row of host.ctx.storage.sql
      .exec<{ entry_id: string }>(
        `SELECT pl.entry_id FROM provider_links pl
         JOIN canonical_entries ce ON ce.id = pl.entry_id
         WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL`,
        link.provider,
        link.externalId,
      )
      .toArray()) {
      matchingEntryIds.add(row.entry_id);
    }
  }
  if (matchingEntryIds.size > 1) {
    throw new Error(
      `Registry candidate links belong to multiple entries: ${[...matchingEntryIds].join(", ")}`,
    );
  }

  const timestamp = now();
  const matchedId = [...matchingEntryIds][0];
  const entryId = matchedId ?? newId();
  if (matchedId) {
    const existingLinks = host.ctx.storage.sql
      .exec<ProviderRow>(
        "SELECT provider, external_id, title, updated_at FROM provider_links WHERE entry_id = ?",
        entryId,
      )
      .toArray();
    const existingByProvider = new Map(existingLinks.map((link) => [link.provider, link]));
    for (const link of links) {
      const existing = existingByProvider.get(link.provider);
      if (existing && existing.external_id !== link.externalId) {
        throw new Error(
          `Registry entry ${entryId} already has ${link.provider}:${existing.external_id}`,
        );
      }
    }
    host.ctx.storage.sql.exec(
      "UPDATE canonical_entries SET updated_at = ? WHERE id = ?",
      timestamp,
      entryId,
    );
  } else {
    const mintProvider =
      input.provider === "anilist" || input.provider === "mal" ? input.provider : "local";
    host.ctx.storage.sql.exec(
      `INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      entryId,
      mintProvider,
      input.providerId,
      input.title,
      timestamp,
      timestamp,
    );
  }

  for (const link of links) {
    host.ctx.storage.sql.exec(
      `INSERT INTO provider_links (entry_id, provider, external_id, title, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entry_id, provider) DO UPDATE SET
         title = COALESCE(excluded.title, provider_links.title),
         updated_at = excluded.updated_at`,
      entryId,
      link.provider,
      link.externalId,
      link.title ?? null,
      timestamp,
    );
  }
  appendEvent(host, entryId, "candidate.ingest", "device", {
    provider: input.provider,
    providerId: input.providerId,
    linkedProviders: links.map((link) => link.provider),
  });
  const entry = readEntry(host, entryId);
  if (!entry) {
    throw new Error(`Registry row not found after candidate ingest: ${entryId}`);
  }
  return entry;
}

export function resolveEntrySync(host: SyncHost, request: ResolveEntryInput): RegistryEntry {
  const timestamp = now();
  // Tombstoned rows are dead lifecycles: a nuked title coming back gets a
  // fresh registry row, never the corpse. History stays in the admin view.
  const existing = host.ctx.storage.sql
    .exec<{ entry_id: string }>(
      `SELECT pl.entry_id FROM provider_links pl
       JOIN canonical_entries ce ON ce.id = pl.entry_id
       WHERE pl.provider = ? AND pl.external_id = ? AND ce.tombstoned_at IS NULL`,
      request.provider,
      request.providerId,
    )
    .toArray()[0];
  if (existing) {
    host.ctx.storage.sql.exec(
      "UPDATE canonical_entries SET title = ?, updated_at = ? WHERE id = ? AND title <> ?",
      request.title,
      timestamp,
      existing.entry_id,
      request.title,
    );
    const entry = readEntry(host, existing.entry_id, false);
    if (!entry) {
      throw new Error(`Registry row vanished for link: ${existing.entry_id}`);
    }
    return entry;
  }

  const id = newId();
  // canonical_entries.provider is CanonicalProvider (anilist|mal|local). Content
  // providers (mangadex/comix) only live on provider_links — mint source stays local.
  const mintProvider =
    request.provider === "anilist" || request.provider === "mal" ? request.provider : "local";
  host.ctx.storage.sql.exec(
    `INSERT INTO canonical_entries (id, provider, provider_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    mintProvider,
    request.providerId,
    request.title,
    timestamp,
    timestamp,
  );
  host.ctx.storage.sql.exec(
    `INSERT INTO provider_links (entry_id, provider, external_id, title, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    request.provider,
    request.providerId,
    request.title,
    timestamp,
  );

  const minted = readEntry(host, id);
  if (!minted) {
    throw new Error(`Registry row not found after mint: ${id}`);
  }
  return minted;
}
