import type * as Effect from "effect/Effect";

export type ComixTitleId = string;
export type ComixChapterId = string;

export interface ComixTitle {
  readonly id: ComixTitleId;
  readonly title: string;
  readonly altTitles: readonly string[];
  readonly description?: string;
}

export interface ComixChapter {
  readonly id: ComixChapterId;
  readonly titleId: ComixTitleId;
  readonly chapterNumber?: number;
  readonly volumeNumber?: number;
  readonly language?: string;
  readonly publishedAt?: number;
}

export interface ComixTransport {
  readonly request: <A>(
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Effect.Effect<A, ComixSourceError>;
  /** Browser-backed transport for Cloudflare challenges and page decryption. */
  readonly browse: <A>(
    input: string,
    parse: (document: string) => A
  ) => Effect.Effect<A, ComixSourceError>;
}

export interface ComixSourceError {
  readonly _tag: "ComixSourceError";
  readonly message: string;
  readonly status?: number;
}

export interface ComixClient {
  readonly search: (
    query: string
  ) => Effect.Effect<readonly ComixTitle[], ComixSourceError>;
  readonly getTitle: (
    titleId: ComixTitleId
  ) => Effect.Effect<ComixTitle, ComixSourceError>;
  readonly getChapters: (
    titleId: ComixTitleId
  ) => Effect.Effect<readonly ComixChapter[], ComixSourceError>;
}
