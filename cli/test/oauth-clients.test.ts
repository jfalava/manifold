import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  isBareLoginInvocation,
  loadStoredOAuthClient,
  resolveOAuthClient,
  resolvePasteOnlyWizard,
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

const clearAniListEnv = (): (() => void) => {
  const previous = process.env.MANIFOLD_ANILIST_CLIENT_ID;
  const previousSecret = process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
  delete process.env.MANIFOLD_ANILIST_CLIENT_ID;
  delete process.env.MANIFOLD_ANILIST_CLIENT_SECRET;
  return () => {
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
    const restore = clearAniListEnv();
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
      restore();
    }
  });

  it("loads from keychain when env is empty (non-wizard)", async () => {
    const store = memoryStore();
    await saveStoredOAuthClient(
      "anilist",
      { clientId: "kc-id", clientSecret: "kc-secret" },
      store,
    );
    const restore = clearAniListEnv();
    try {
      const resolved = await resolveOAuthClient({
        kind: "anilist",
        clientIdFlag: Option.none(),
        clientSecretFlag: Option.none(),
        requireSecret: true,
        store,
        isTty: false,
        wizard: false,
      });
      expect(resolved).toEqual({
        clientId: "kc-id",
        clientSecret: "kc-secret",
        prompted: false,
      });
    } finally {
      restore();
    }
  });

  it("wizard walks every field and saves to keychain", async () => {
    const store = memoryStore();
    const restore = clearAniListEnv();
    const prompts: string[] = [];
    try {
      const resolved = await resolveOAuthClient({
        kind: "anilist",
        clientIdFlag: Option.none(),
        clientSecretFlag: Option.none(),
        requireSecret: true,
        store,
        isTty: true,
        wizard: true,
        promptWithDefault: async (message, def) => {
          prompts.push(`${message}|${def ?? ""}`);
          return "wizard-id";
        },
        promptSecret: async (message) => {
          prompts.push(message);
          return "wizard-secret";
        },
      });
      expect(resolved).toEqual({
        clientId: "wizard-id",
        clientSecret: "wizard-secret",
        prompted: true,
      });
      expect(prompts.some((p) => p.startsWith("AniList client id"))).toBe(true);
      await expect(loadStoredOAuthClient("anilist", store)).resolves.toEqual({
        clientId: "wizard-id",
        clientSecret: "wizard-secret",
      });
    } finally {
      restore();
    }
  });

  it("wizard keeps keychain defaults on empty Enter", async () => {
    const store = memoryStore();
    await saveStoredOAuthClient(
      "anilist",
      { clientId: "keep-id", clientSecret: "keep-secret" },
      store,
    );
    const restore = clearAniListEnv();
    try {
      const resolved = await resolveOAuthClient({
        kind: "anilist",
        clientIdFlag: Option.none(),
        clientSecretFlag: Option.none(),
        requireSecret: true,
        store,
        isTty: true,
        wizard: true,
        promptWithDefault: async (_message, def) => def ?? "",
        promptSecret: async () => "",
      });
      expect(resolved).toEqual({
        clientId: "keep-id",
        clientSecret: "keep-secret",
        prompted: true,
      });
    } finally {
      restore();
    }
  });

  it("fails headless when nothing is configured", async () => {
    const store = memoryStore();
    const restore = clearAniListEnv();
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
      restore();
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

  it("detects bare login invocations", () => {
    expect(isBareLoginInvocation(Option.none(), Option.none(), false)).toBe(true);
    expect(isBareLoginInvocation(Option.some("x"), Option.none(), false)).toBe(false);
    expect(isBareLoginInvocation(Option.none(), Option.none(), true)).toBe(false);
  });

  it("asks paste-only only in wizard mode", async () => {
    await expect(resolvePasteOnlyWizard(false, false)).resolves.toBe(false);
    await expect(
      resolvePasteOnlyWizard(false, true, {
        isTty: true,
        confirm: async () => true,
      }),
    ).resolves.toBe(true);
  });
});
