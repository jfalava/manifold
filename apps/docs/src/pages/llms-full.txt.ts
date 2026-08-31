// Full-corpus markdown for AI agents — every published page in one
// document. Scope and collation live in the framework helper; reshape or
// delete this route to change the site's corpus policy.
import { getIndexedEntries, renderCorpusMarkdown } from "@cloudflare/nimbus-docs";
import { withBaseInText } from "../lib/urls";
import { config } from "virtual:nimbus/config";

export const prerender = true;

export async function GET() {
  const entries = await getIndexedEntries();
  const generatedPaths = [
    "/llms.txt",
    ...entries.flatMap((entry) => [entry.url, entry.markdownUrl, entry.sourceUrl].filter((path): path is string => path !== undefined)),
  ];

  return new Response(withBaseInText(await renderCorpusMarkdown(), config.site, generatedPaths), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
