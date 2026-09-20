import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  loadStoredOAuthClient,
  resolveOAuthClient,
  saveStoredOAuthClient,
  type OAuthClientSecretStore,
} from "../src/login/oauth-clients";

const memoryStore = (): OAuthClientSecretStore & {
  readonly data: Map<string, string>;
} => {
  const data = new Map<string, string>();
  return {
    data,
    get: async (ref) => data.get(`${ref.service}:${ref.name}`) ?? null,
    set: async (ref) => {
      data.set(`${ref.service}:${ref.name}`, ref.value);
    },
  };
};

describe("oauth client credentials", () => {
  it("round-trips keychain storage", async () => {
    const store = memoryStore();
    await saveStoredOAuthClient(
      "anilist",
      { clientId: "id-1", clientSecret: "sec-1" },
      store,
    );
    await expect(loadStoredOAuthClient("anilist", store)).resolves.toEqual({
      clientId: "id-1",
      clientSecret: "sec-1",
    });
  });

  it("uses env/flag without prompting", async () => {
    const store = memoryStore();
    const previous = process.env.MANIFOLD_ANILIST_CLIENT_ID;
    const previousSecret = process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
    process.env.MANIFOLD_ANILIST_CLIENT_ID = "env-id";
    process.env.MANIFOLD_ANILIST_CLIENT_SECRET = "env-secret";
    try {
      const resolved = await resolveOAuthClient({
        kind: "anilist",
        clientIdFlag: Option.none(),
        clientSecretFlag: Option.none(),
        requireSecret: true,
        store,
        isTty: false,
      });
      expect(resolved).toEqual({
        clientId: "env-id",
        clientSecret: "env-secret",
        prompted: false,
      });
      expect(store.data.size).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.MANIFOLD_ANILIST_CLIENT_ID;
      } else {
        process.env.MANIFOLD_ANILIST_CLIENT_ID = previous;
      }
      if (previousSecret === undefined) {
        delete process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
      } else {
        process.env.MANIFOLD_ANILIST_CLIENT_SECRET = previousSecret;
      }
    }
  });

  it("loads from keychain when env is empty", async () => {
    const store = memoryStore();
    await saveStoredOAuthClient(
      "anilist",
      { clientId: "kc-id", clientSecret: "kc-secret" },
      store,
    );
    const previous = process.env.MANIFOLD_ANILIST_CLIENT_ID;
    const previousSecret = process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
    delete process.env.MANIFOLD_ANILIST_CLIENT_ID;
    delete process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
    try {
      const resolved = await resolveOAuthClient({
        kind: "anilist",
        clientIdFlag: Option.none(),
        clientSecretFlag: Option.none(),
        requireSecret: true,
        store,
        isTty: false,
      });
      expect(resolved).toEqual({
        clientId: "kc-id",
        clientSecret: "kc-secret",
        prompted: false,
      });
    } finally {
      if (previous !== undefined) {
        process.env.MANIFOLD_ANILIST_CLIENT_ID = previous;
      }
      if (previousSecret !== undefined) {
        process.env.MANIFOLD_ANILIST_CLIENT_SECRET = previousSecret;
      }
    }
  });

  it("prompts on TTY and saves to keychain", async () => {
    const store = memoryStore();
    const previous = process.env.MANIFOLD_ANILIST_CLIENT_ID;
    const previousSecret = process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
    delete process.env.MANIFOLD_ANILIST_CLIENT_ID;
    delete process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
    try {
      const resolved = await resolveOAuthClient({
        kind: "anilist",
        clientIdFlag: Option.none(),
        clientSecretFlag: Option.none(),
        requireSecret: true,
        store,
        isTty: true,
        prompt: async () => "prompt-id",
        promptSecret: async () => "prompt-secret",
      });
      expect(resolved).toEqual({
        clientId: "prompt-id",
        clientSecret: "prompt-secret",
        prompted: true,
      });
      await expect(loadStoredOAuthClient("anilist", store)).resolves.toEqual({
        clientId: "prompt-id",
        clientSecret: "prompt-secret",
      });
    } finally {
      if (previous !== undefined) {
        process.env.MANIFOLD_ANILIST_CLIENT_ID = previous;
      }
      if (previousSecret !== undefined) {
        process.env.MANIFOLD_ANILIST_CLIENT_SECRET = previousSecret;
      }
    }
  });

  it("fails headless when nothing is configured", async () => {
    const store = memoryStore();
    const previous = process.env.MANIFOLD_ANILIST_CLIENT_ID;
    const previousSecret = process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
    delete process.env.MANIFOLD_ANILIST_CLIENT_ID;
    delete process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
    try {
      await expect(
        resolveOAuthClient({
          kind: "anilist",
          clientIdFlag: Option.none(),
          clientSecretFlag: Option.none(),
          requireSecret: true,
          store,
          isTty: false,
        }),
      ).rejects.toThrow(/Missing AniList OAuth client credentials/);
    } finally {
      if (previous !== undefined) {
        process.env.MANIFOLD_ANILIST_CLIENT_ID = previous;
      }
      if (previousSecret !== undefined) {
        process.env.MANIFOLD_ANILIST_CLIENT_SECRET = previousSecret;
      }
    }
  });

  it("allows MAL without secret", async () => {
    const store = memoryStore();
    const previous = process.env.MANIFOLD_MAL_CLIENT_ID;
    const previousSecret = process.env.MANIFOLD_MAL_CLIENT_SECRET;
    delete process.env.MANIFOLD_MAL_CLIENT_ID;
    delete process.env.MANIFOLD_MAL_CLIENT_SECRET;
    try {
      const resolved = await resolveOAuthClient({
        kind: "mal",
        clientIdFlag: Option.some("mal-id"),
        clientSecretFlag: Option.none(),
        requireSecret: false,
        store,
        isTty: false,
      });
      expect(resolved).toEqual({
        clientId: "mal-id",
        clientSecret: undefined,
        prompted: false,
      });
    } finally {
      if (previous !== undefined) {
        process.env.MANIFOLD_MAL_CLIENT_ID = previous;
      }
      if (previousSecret !== undefined) {
        process.env.MANIFOLD_MAL_CLIENT_SECRET = previousSecret;
      }
    }
  });
});
