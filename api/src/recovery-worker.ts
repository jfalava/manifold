import worker, { ManifoldSync } from "./index";
import { authorized } from "./http";
import { readBackupBody } from "./registry-backup";
import type { JsonValue } from "@manifold/json";
import type { Env } from "./types";

export { ManifoldSync };

// A self-contained bundle for a NEW Worker/namespace. No router, Alchemy state,
// Secrets Store, or R2 bucket is needed to recover an offline archive.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!(await authorized(request, env))) {return new Response("Unauthorized", { status: 401 });}
    const url = new URL(request.url);
    if (url.pathname === "/recovery/restore" && request.method === "POST") {
      if (request.headers.get("x-confirm-restore") !== "true" || !request.body) {
        return new Response("Restore confirmation and body required", { status: 400 });
      }
      try {
        const backup = await readBackupBody(request.body);
        const input: JsonValue = JSON.parse(JSON.stringify(backup));
        await env.MANIFOLD_SYNC.getByName("default").restoreRegistryData(input);
        return Response.json({ restored: true, syncPaused: true });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Restore failed" }, { status: 400 });
      }
    }
    url.hostname = "manifold.jfa.dev";
    if (url.pathname.startsWith("/api/")) {url.pathname = url.pathname.slice(4);}
    return worker.fetch(new Request(url, request), env, ctx);
  },
};
