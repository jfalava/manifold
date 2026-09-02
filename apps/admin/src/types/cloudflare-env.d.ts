/**
 * manifold-admin bindings deployed via iac/alchemy.run.ts. Augments the global
 * `Cloudflare.Env` from @cloudflare/workers-types — the same shape
 * `wrangler types` generates. Keep in sync when bindings change.
 *
 * Secrets can surface as handle objects rather than plain strings depending
 * on the environment, hence the unions (see resolveSecret consumers).
 */

interface AlchemySecret {
  get?: () => Promise<unknown>;
  value?: unknown;
}

declare namespace Cloudflare {
  interface Env {
    CF_ACCOUNT_ID: string;
    ADMIN_PANEL_ANALYTICS_API: string | AlchemySecret;
    MANIFOLD_TOKEN: string | AlchemySecret;
    MANIFOLD_API_ORIGIN?: string;
    SYNC_API?: Fetcher;
    ADMIN_CACHE?: KVNamespace;
  }
}
