import { Data, Option, Schema } from "effect";
import type { JsonObject } from "@manifold/json";
import { epochMillisNow } from "@/effect-kit";

const CatalogRead = Schema.Struct({
  event: Schema.Literal("catalog"),
  version: Schema.Literal(1),
  origin: Schema.String,
  kind: Schema.Literal("read"),
  key: Schema.String,
  savedAt: Schema.Finite,
  data: Schema.String,
});

/** Only catalog response bodies belong here. Callers decode them on every read. */
export const registryCatalog = (options: {
  readonly origin: string;
  readonly catalog?: readonly JsonObject[];
  readonly onCache?: (record: JsonObject) => void;
}) => {
  const reads = new Map<string, Schema.Schema.Type<typeof CatalogRead>>();
  for (const line of options.catalog ?? []) {
    const decoded = Schema.decodeUnknownOption(CatalogRead)(line);
    if (Option.isSome(decoded) && decoded.value.origin === options.origin) {
      reads.set(decoded.value.key, decoded.value);
    }
  }
  return {
    read(key: string): string | undefined {
      const entry = reads.get(key);
      const age = entry ? epochMillisNow() - entry.savedAt : -1;
      return age >= 0 && age < 86_400_000 ? entry!.data : undefined;
    },
    forget(key: string): void {
      reads.delete(key);
      options.onCache?.({
        event: "catalog",
        version: 1,
        origin: options.origin,
        kind: "read",
        key,
        savedAt: 0,
        data: "",
      });
    },
    remember(key: string, data: string): void {
      const entry = {
        event: "catalog" as const,
        version: 1 as const,
        origin: options.origin,
        kind: "read" as const,
        key,
        savedAt: epochMillisNow(),
        data,
      };
      reads.set(key, entry);
      options.onCache?.(entry);
    },
  };
};

export class RegistryPageBudgetError extends Data.TaggedError("RegistryPageBudgetError")<{
  readonly message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
