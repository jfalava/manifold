import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  site: "https://manifold.jfa.dev",
  title: "MANIFOLD",
  description: "Production documentation for Manifold and its Paperback source.",
  locale: "en",
  homeLabel: "Manifold",
  github: "https://github.com/jfalava/manifold",
  sidebar: {
    scope: "full",
    items: [
      {
        label: "Guides",
        items: ["architecture", "auth", "install", "development"],
      },
      {
        label: "CLI",
        items: [
          "cli",
          { label: "migrate", autogenerate: { directory: "cli/migrate" } },
          { label: "ops", autogenerate: { directory: "cli/ops" } },
          { label: "registry", autogenerate: { directory: "cli/registry" } },
          "cli/reconcile-diff",
          "cli/stale-status",
          "cli/unfollow-dropped",
        ],
      },
    ],
  },
  socialImageAlt: "Manifold documentation preview",
});

export default defineConfig({
  base: "/",
  output: "static",
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    // Satteri is a build-time Markdown processor. Prefer its host-native
    // binding instead of the browser/WASI condition used by Cloudflare's
    // runtime bundle.
    resolve: { conditions: ["node", "import", "default"] },
    plugins: [tailwindcss()],
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers. Add the others
      // (heading hierarchy, code-block language, style, etc.) when you're
      // ready to enforce them — see `nimbus-docs lint --help`.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      // Wrap wide tables so they scroll instead of overflowing the page
      // (styled by `.nb-table-scroll` in src/styles/prose.css).
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
