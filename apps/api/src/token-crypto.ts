import { readSecret } from "./read-secret";
import type { Env } from "./types";

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {binary += String.fromCharCode(byte);}
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

const encryptionKey = async (
  env: Pick<Env, "OAUTH_TOKEN_ENCRYPTION_SECRET">,
): Promise<CryptoKey> => {
  const encryptionSecret = await readSecret(
    env.OAUTH_TOKEN_ENCRYPTION_SECRET,
    "OAUTH_TOKEN_ENCRYPTION_SECRET",
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(encryptionSecret),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
};

export const encryptToken = async (
  env: Pick<Env, "OAUTH_TOKEN_ENCRYPTION_SECRET">,
  value: string,
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(value),
  );
  const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.byteLength);
  return toBase64Url(combined);
};

export const decryptToken = async (
  env: Pick<Env, "OAUTH_TOKEN_ENCRYPTION_SECRET">,
  value: string,
): Promise<string> => {
  const combined = fromBase64Url(value);
  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    encrypted,
  );
  return new TextDecoder().decode(decrypted);
};
