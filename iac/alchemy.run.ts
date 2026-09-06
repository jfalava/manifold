import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { ManifoldSync as ManifoldSyncClass } from "../api/src/manifold-sync";

import { defineManagedSecrets } from "./src/secrets";

// This is binding metadata for the ManifoldApi host, not a standalone
// resource. ManifoldApi is retained below, and the pinned Alchemy provider
// fails closed if this class ever appears in deleted_classes.
export const ManifoldSync = Cloudflare.DurableObject<ManifoldSyncClass>("ManifoldSync");

// Backups are independently retained so a stack teardown cannot remove the
// R2 recovery path along with the Worker.
export const RegistryBackups = Cloudflare.R2.Bucket("RegistryBackups", {
  name: "manifold-registry-backups"
}).pipe(RemovalPolicy.retain());

export const SharedSecretsStore = Cloudflare.SecretsStore.Store(
  "SharedSecretsStore"
);

/** Secrets provisioned into the account Secrets Store and bound to SyncApi
 * as `secrets_store_secret` bindings. Non-sensitive identifiers (client IDs,
 * redirect base URL) remain plain vars sourced from iac/.env. */
const SYNC_SECRET_NAMES = [
  "MANIFOLD_TOKEN",
  "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET",
  "MANIFOLD_ANILIST_CLIENT_SECRET",
  "MANIFOLD_MAL_CLIENT_SECRET",
  "MANIFOLD_MANGADEX_CLIENT_SECRET",
  "MANIFOLD_MANGADEX_USERNAME",
  "MANIFOLD_MANGADEX_PASSWORD"
] as const;

const MANAGED_SECRET_NAMES = [...SYNC_SECRET_NAMES, "MANIFOLD_ADMIN_PANEL_ANALYTICS_API"];

const CF_ACCOUNT_ID = "cb3d0c5cb46f4e801b0b7f4cc3fc78d3";

export const MangaDexIndex = Cloudflare.Vectorize.Index("MangaDexIndex", {
  name: "manifold-mangadex",
  dimensions: 1024,
  metric: "cosine",
  description: "MangaDex manga title embeddings for AniList canonical matching"
});

export const MangaDexAniListMetadataIndex = Effect.gen(function* () {
  const index = yield* MangaDexIndex;
  return yield* Cloudflare.Vectorize.MetadataIndex("MangaDexAniListMetadataIndex", {
    indexName: index.indexName,
    propertyName: "anilistId",
    indexType: "string"
  });
});

export const MangaDexMalMetadataIndex = Effect.gen(function* () {
  const index = yield* MangaDexIndex;
  return yield* Cloudflare.Vectorize.MetadataIndex("MangaDexMalMetadataIndex", {
    indexName: index.indexName,
    propertyName: "malId",
    indexType: "string"
  });
});

const debugObservability = {
  enabled: true,
  headSamplingRate: 1,
  logs: {
    enabled: true,
    invocationLogs: true,
    headSamplingRate: 1,
    persist: true
  },
  traces: {
    enabled: true,
    headSamplingRate: 1,
    persist: true
  }
} as const;

export const ManifoldApi = Cloudflare.Worker("ManifoldApi", {
  name: "manifold-api",
  main: "../api/src/index.ts",
  workersDev: false,
  observability: debugObservability,
  compatibility: {
    date: "2026-08-20",
    flags: ["nodejs_compat"]
  },
  assets: {
    directory: "../api/catalog-assets",
    runWorkerFirst: true,
  },
  crons: ["0 3 * * *"],
  env: {
    AI: Cloudflare.Workers.AI(),
    MANGADEX_INDEX: MangaDexIndex,
    MANIFOLD_SYNC: ManifoldSync,
    REGISTRY_BACKUPS: RegistryBackups,
    ENVIRONMENT: "production",
    MANIFOLD_OAUTH_REDIRECT_BASE_URL: Config.string("MANIFOLD_OAUTH_REDIRECT_BASE_URL"),
    MANIFOLD_ANILIST_CLIENT_ID: Config.string("MANIFOLD_ANILIST_CLIENT_ID"),
    MANIFOLD_MAL_CLIENT_ID: Config.string("MANIFOLD_MAL_CLIENT_ID"),
    MANIFOLD_MANGADEX_CLIENT_ID: Config.string("MANIFOLD_MANGADEX_CLIENT_ID")
  }
}).pipe(RemovalPolicy.retain());

export const Worker = ManifoldApi;

export const ManifoldDocsAssets = Cloudflare.Website.StaticSite("ManifoldDocsAssets", {
  name: "manifold-docs-assets",
  cwd: "../docs",
  command: "bun run build",
  outdir: "dist",
  workersDev: false,
  compatibility: {
    date: "2026-08-20",
    flags: ["nodejs_compat"]
  },
  assets: { notFoundHandling: "404-page" }
});

export type WorkerEnv = Cloudflare.InferEnv<typeof ManifoldApi>;

export const ManifoldDocs = Cloudflare.Worker("ManifoldDocs", {
  name: "manifold-docs",
  main: "../docs/src/worker.ts",
  workersDev: false,
  observability: debugObservability,
  compatibility: {
    date: "2026-08-20",
    flags: ["nodejs_compat"]
  },
  env: {
    DOCS_ASSETS: ManifoldDocsAssets
  }
});

/** Snapshot cache for the admin dashboard's server functions (analytics,
 * cache metrics, library overview) — survives isolate eviction so the
 * Overview renders from the last stored snapshot instead of recomputing. */
export const AdminCache = Cloudflare.KV.Namespace("AdminCache", {
  title: "manifold-admin-cache"
});

export const ManifoldAdmin = Cloudflare.Website.Vite("ManifoldAdmin", {
  name: "manifold-admin",
  rootDir: "../admin",
  // Same pattern as jfa.dev keweke: explicit server entry + assets config.
  // runWorkerFirst: true so service-binding traffic (router → ADMIN.fetch)
  // always hits src/server.ts, which serves client files via env.ASSETS.
  main: "src/server.ts",
  assets: {
    runWorkerFirst: true
  },
  workersDev: false,
  observability: debugObservability,
  memo: {
    include: ["**/*"],
    lockfile: true,
  },
  env: {
    CF_ACCOUNT_ID,
    // Direct service binding: admin's server functions call the sync API
    // without a public-hostname round trip (same-zone subrequests 522).
    SYNC_API: ManifoldApi,
    ADMIN_CACHE: AdminCache
  }
});

export const ManifoldRouter = Cloudflare.Worker("ManifoldRouter", {
  name: "manifold-router",
  main: "../router/src/index.ts",
  domain: "manifold.jfa.dev",
  workersDev: false,
  observability: debugObservability,
  compatibility: {
    date: "2026-08-20",
    flags: ["nodejs_compat"]
  },
  env: {
    SYNC_API: ManifoldApi,
    DOCS_WORKER: ManifoldDocs,
    ADMIN: ManifoldAdmin
  }
});

export default Alchemy.Stack(
  "Manifold",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state()
  },
  Effect.gen(function* () {
    const mangaDexIndex = yield* MangaDexIndex;
    yield* MangaDexAniListMetadataIndex;
    yield* MangaDexMalMetadataIndex;

    // The store is account-scoped and already exists; the provider adopts it
    // and never deletes it. Values supplied via MANIFOLD_* entries in iac/.env
    // are provisioned into the store; SyncApi binds its own subset as
    // `secrets_store_secret` bindings.
    const sharedSecretsStore = yield* SharedSecretsStore;
    const syncApiResource = yield* ManifoldApi;
    yield* defineManagedSecrets(sharedSecretsStore, MANAGED_SECRET_NAMES);
    yield* syncApiResource.bind("SyncSecretsStoreBindings", {
      bindings: SYNC_SECRET_NAMES.map((secretName) => ({
        type: "secrets_store_secret" as const,
        name: secretName,
        secretName,
        storeId: sharedSecretsStore.storeId
      }))
    });

    const router = yield* ManifoldRouter;
    const dfAdmin = yield* ManifoldAdmin;
    yield* dfAdmin.bind("ManifoldAdminSecretsStoreBindings", {
      bindings: [
        {
          type: "secrets_store_secret" as const,
          name: "MANIFOLD_ADMIN_PANEL_ANALYTICS_API",
          secretName: "MANIFOLD_ADMIN_PANEL_ANALYTICS_API",
          storeId: sharedSecretsStore.storeId
        },
        {
          type: "secrets_store_secret" as const,
          name: "MANIFOLD_TOKEN",
          secretName: "MANIFOLD_TOKEN",
          storeId: sharedSecretsStore.storeId
        }
      ]
    });
    return {
      url: router.url,
      routerUrl: router.url,
      apiUrl: Output.interpolate`${router.url}/api`,
      docsUrl: router.url,
      adminUrl: dfAdmin.url ?? Output.interpolate`${router.url}/admin`,
      paperbackUrl: Output.interpolate`${router.url}/paperback`,
      mangaDexIndex: mangaDexIndex.indexName
    };
  })
);
