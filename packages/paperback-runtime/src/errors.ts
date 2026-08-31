export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const props = Object.getOwnPropertyNames(error)
      .map((key) => `${key}=${String(record[key])}`)
      .join(", ");
    const name =
      typeof record.name === "string" && record.name
        ? record.name
        : (error.constructor?.name ?? "object");
    return `${name}{${props}}`;
  }
  return String(error);
};
