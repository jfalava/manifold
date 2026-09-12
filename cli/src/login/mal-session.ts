import { decodeJsonOrThrow, parseJsonValue } from "@/effect-kit";

import { MalSession } from "@/mal";

export const MAL_SECRET = { service: "manifold", name: "mal-session" };

export const saveMalSession = (session: MalSession): Promise<void> =>
  Bun.secrets.set({ ...MAL_SECRET, value: JSON.stringify(session) });

export const loadMalSession = async (): Promise<MalSession | undefined> => {
  const stored = await Bun.secrets.get(MAL_SECRET);
  if (!stored) {
    return undefined;
  }
  try {
    return decodeJsonOrThrow(MalSession, parseJsonValue(stored), "decode");
  } catch {
    throw new Error("Invalid MAL keychain session. Run login mal again.");
  }
};
