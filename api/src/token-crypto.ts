import { Data, Effect } from "effect";
import { readSecret } from "./read-secret";
import type { Env } from "./types";

export class TokenCryptoError extends Data.TaggedError("TokenCryptoError")<{
  readonly message: string;
}> {}

const asCryptoError = (cause: unknown) =>
  new TokenCryptoError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===";
  const binary = atob(padded.slice(0, padded.length - (padded.length % 4)));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const encryptionKey = (
  env: Pick<Env, "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET">,
): Effect.Effect<CryptoKey, TokenCryptoError> =>
  Effect.gen(function* () {
    const encryptionSecret = yield* Effect.tryPromise({
      try: () =>
        readSecret(
          env.MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET,
          "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET",
        ),
      catch: asCryptoError,
    });
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionSecret)),
      catch: asCryptoError,
    });
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
      catch: asCryptoError,
    });
  });

export const encryptToken = (
  env: Pick<Env, "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET">,
  value: string,
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = yield* encryptionKey(env);
      const encrypted = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)),
        catch: asCryptoError,
      });
      const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.byteLength);
      return toBase64Url(combined);
    }),
  );

export const decryptToken = (
  env: Pick<Env, "MANIFOLD_OAUTH_TOKEN_ENCRYPTION_SECRET">,
  value: string,
): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const combined = fromBase64Url(value);
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);
      const key = yield* encryptionKey(env);
      const decrypted = yield* Effect.tryPromise({
        try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted),
        catch: asCryptoError,
      });
      return new TextDecoder().decode(decrypted);
    }),
  );
