import { Effect, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { errorMessage } from "@manifold/json";
import { AuthConnection } from "@manifold/contract";
import cliProgress from "cli-progress";

import { apiCall, apiConfig } from "@/commands/toolbox";
import { resolveValue } from "@/env-resolve";
import {
  createMalAuthorization, createMalClient, MAL_REDIRECT_URI, MalSession,
  requestMalTokens, wipeMalManga,
} from "@/mal";
import { abortFrame, closeFrame, frameDetail, openFrame } from "@/ui";

const SECRET = { service: "manifold", name: "mal-session" };
const saveSession = (session: MalSession): Promise<void> =>
  Bun.secrets.set({ ...SECRET, value: JSON.stringify(session) });

const loadSession = async (): Promise<MalSession | undefined> => {
  const stored = await Bun.secrets.get(SECRET);
  if (!stored) {return undefined;}
  try {
    return Schema.decodeUnknownSync(MalSession)(JSON.parse(stored));
  } catch {
    throw new Error("Invalid MAL keychain session. Run mal login again.");
  }
};

const malLogin = Command.make("login", {
  clientId: Flag.string("client-id").pipe(Flag.optional,
    Flag.withDescription("MAL OAuth client ID. Falls back to MANIFOLD_MAL_CLIENT_ID.")),
}).pipe(
  Command.withDescription(`Authorize MAL locally; register ${MAL_REDIRECT_URI} as the OAuth redirect URI.`),
  Command.withHandler(({ clientId }) => Effect.tryPromise({
    try: async () => {
      const id = resolveValue(clientId, "MANIFOLD_MAL_CLIENT_ID");
      if (!id) {throw new Error("Set MANIFOLD_MAL_CLIENT_ID or pass --client-id.");}
      openFrame("mal login");
      const auth = createMalAuthorization(id);
      const callback = Promise.withResolvers<string>();
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 8766,
        fetch(request) {
          const url = new URL(request.url);
          const headers = { "content-type": "text/plain", "cache-control": "no-store" };
          if (request.method !== "GET" || url.pathname !== "/callback") {
            return new Response("Not found", { status: 404, headers });
          }
          if (url.searchParams.get("state") !== auth.state) {
            return new Response("Invalid OAuth state", { status: 400, headers });
          }
          if (url.searchParams.has("error")) {
            callback.reject(new Error("MAL authorization denied."));
            return new Response("Authorization denied. Return to the CLI.", { headers });
          }
          const code = url.searchParams.get("code");
          if (!code) {return new Response("Missing authorization code", { status: 400, headers });}
          callback.resolve(code);
          return new Response("Authorization received. Return to the CLI to check the result.", { headers });
        },
      });
      const timer = setTimeout(() => callback.reject(new Error("MAL login timed out after five minutes.")), 300_000);
      try {
        frameDetail(`Open this URL in your browser:\n${auth.url}`);
        const code = await callback.promise;
        const session = await requestMalTokens(id, process.env.MANIFOLD_MAL_CLIENT_SECRET,
          new URLSearchParams({
            grant_type: "authorization_code", code, code_verifier: auth.verifier,
            redirect_uri: MAL_REDIRECT_URI,
          }));
        const profile = await createMalClient({ accessToken: session.accessToken }).profile();
        await saveSession(session);
        closeFrame(`Signed in as ${profile.name} (${profile.id}). Tokens saved in the OS keychain.`);
      } finally {
        clearTimeout(timer);
        await server.stop(true);
      }
    },
    catch: (cause) => new Error(errorMessage(cause)),
  }).pipe(Effect.onError(() => Effect.sync(abortFrame)))),
);

export const malCommand = Command.make("mal").pipe(
  Command.withDescription("MyAnimeList authentication."),
  Command.withSubcommands([malLogin]),
);

export const wipeMalCommand = Command.make("wipe-mal", {
  malToken: Flag.string("mal-token").pipe(Flag.optional,
    Flag.withDescription("Overrides keychain login. Prefer MANIFOLD_MAL_TOKEN to keep tokens out of shell history.")),
  apply: Flag.boolean("apply").pipe(Flag.withDefault(false),
    Flag.withDescription("Delete all MAL manga list entries. Default is a read-only dry run; anime is never touched.")),
  backupPaused: Flag.boolean("backup-paused").pipe(Flag.withDefault(false),
    Flag.withDescription("Acknowledge all other MAL writers are paused/disconnected. Required with --apply.")),
  apiOrigin: Flag.string("api-origin").pipe(Flag.optional,
    Flag.withDescription("Personal API origin for the backup-connection check. Falls back to MANIFOLD_API_ORIGIN.")),
  apiToken: Flag.string("api-token").pipe(Flag.optional,
    Flag.withDescription("Personal API token for the backup-connection check. Falls back to MANIFOLD_TOKEN.")),
}).pipe(
  Command.withDescription("Wipe MAL manga only, across every status, including adult entries. Does not read or modify AniList."),
  Command.withHandler(({ malToken, apply, backupPaused, apiOrigin, apiToken }) => Effect.tryPromise({
    try: async () => {
      if (apply && !backupPaused) {
        throw new Error("Pause/disconnect other MAL writers, then pass --backup-paused with --apply.");
      }
      openFrame("wipe-mal (manga only)");
      if (resolveValue(apiToken, "MANIFOLD_TOKEN")) {
        const connection = await apiCall(apiConfig(apiOrigin, apiToken), "/v1/auth/mal", "GET", undefined, AuthConnection);
        if (connection.connected) {
          if (apply) {throw new Error("The Manifold API is still connected to MAL. Disconnect its MAL backup before wiping; --backup-paused does not override this check.");}
          frameDetail("Warning: Manifold's MAL backup is connected and can recreate entries. Disconnect it before --apply.");
        }
      } else {
        frameDetail("API backup connection not checked: MANIFOLD_TOKEN is unset. Verify other writers are paused yourself.");
      }
      const accessToken = resolveValue(malToken, "MANIFOLD_MAL_TOKEN");
      const client = createMalClient({
        accessToken, session: accessToken ? undefined : await loadSession(),
        clientSecret: process.env.MANIFOLD_MAL_CLIENT_SECRET, saveSession,
      });
      const progress = new cliProgress.SingleBar({
        stream: process.stdout,
        format: "│  {bar} {percentage}% · {value}/{total} manga · elapsed {duration_formatted} · ETA {eta_formatted}",
        barsize: 24,
        barCompleteChar: "█",
        barIncompleteChar: "░",
        hideCursor: true,
      });
      let progressStarted = false;
      const result = await wipeMalManga({
        client, apply,
        scanned: (account, entries) => {
          frameDetail(`Signed in as ${account}. Scanned ${entries.length} manga entries.`);
        },
        progress: (deleted, total) => {
          if (!progressStarted) {
            progress.start(total, deleted);
            progressStarted = true;
          } else {
            progress.update(deleted);
          }
        },
      }).finally(() => progress.stop());
      const account = `${result.account} (${result.accountId})`;
      if (!apply) {closeFrame(`Dry run: ${account}, ${result.scanned} manga entries would be deleted. No entries changed.`);}
      else if (result.scanned === 0) {closeFrame(`${account}: manga list is already empty.`);}
      else {closeFrame(`${account}: deleted ${result.deleted} manga entries; verified empty. Anime untouched.`);}
    },
    catch: (cause) => new Error(errorMessage(cause)),
  }).pipe(Effect.onError(() => Effect.sync(abortFrame)))),
);
