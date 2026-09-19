# Licensing and attributions

Manifold is a mixed-license repository:

- Manifold-authored code is released under the [MIT License](./LICENSE-MIT).
- Code derived from Inkdex remains under the [GNU General Public License,
  version 3 or any later version](./LICENSE).

The notices below identify the derived components and their upstream source.
Do not apply the GPL notice to unrelated Manifold-authored code merely because
it is in the same repository.

## Inkdex-derived Paperback code

Manifold contains modified code derived from Inkdex's Paperback extension
repositories. The original code is GPL-3.0-or-later and remains subject to its
copyright and license terms:

- [Inkdex General Extensions](https://github.com/inkdex/general-extensions),
  branch `0.9/stable`, including the Comix and MangaDex extensions. The
  relevant upstream paths are `src/Comix/` and `src/MangaDex/`.
- [Inkdex Tracker Extensions](https://github.com/inkdex/tracker-extensions),
  branch `0.9/stable`, including the AniList extension. The relevant upstream
  path is `src/AniList/`.

The corresponding Manifold-derived implementation is in:

- `packages/paperback-comix/`
- `packages/mangadex/`
- `packages/paperback-runtime/src/anilist-graphql.ts` (AniList runtime)
- `tracker/src/MANIFOLD/main.ts`
- `tracker/src/MANIFOLD/managed-collections.ts`
- `tracker/src/MANIFOLD/pbconfig.ts`
- `tracker/src/MANIFOLD/read-queue.ts`

The files carrying the upstream-derived implementation preserve an Inkdex
copyright notice alongside a dated Manifold modification notice. Other files
in these directories are Manifold-authored support code and are MIT-licensed;
they do not imply an Inkdex copyright claim. The generated `MANIFOLD` and
`MANIFOLD-beta` bundles combine these components and are distributed under
GPL-3.0-or-later. The current repository contains the source needed to rebuild
the generated Paperback bundles served by the Manifold catalog.

The API and CLI are MIT-licensed as Manifold source. They import and use the
GPL-derived MangaDex package; when those components are conveyed together as a
single combined executable, the applicable GPL requirements still apply to
that combined work.

The Inkdex extension registry at
[`inkdex/extensions`](https://github.com/inkdex/extensions) is only a generated
registry containing bundles, assets, and registry automation; it is not the
source of the extension implementations. Its absence of a root license does
not replace the licenses above.

## Provider content and branding

This license covers Manifold's software, not content returned by Comix,
MangaDex, or AniList. Titles, descriptions, covers, chapter pages, metadata,
provider APIs, and service terms remain controlled by their respective
providers and rights holders. Provider names and logos are used descriptively
and do not imply affiliation or endorsement.

## Other dependencies

Third-party dependencies such as Paperback's types/toolchain and Effect keep
their own licenses. When dependency code is incorporated into a generated
bundle, its applicable notices and license terms continue to apply. Build-only
tools and erased type imports are different from code included in a bundle;
check each dependency's distribution when determining which notices to ship.
