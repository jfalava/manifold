# Vendored anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13), path `skills/install-anti-slop/assets/anti-slop/`.

Base before this update: upstream `e8c4880` (v0.1.2). All 23 previously vendored files matched it byte-for-byte, so the update applied every upstream change with no local deviations to merge.

The vendored tree matches the upstream snapshot exactly. Local policy lives in the root `oxlint.config.ts`, not in this directory.

## Rules not enabled

These upstream rules are vendored but deliberately left off in `oxlint.config.ts`, pending cleanup. The finding counts are from 2026-11-01:

- `anti-slop/require-readable-spacing`: 4775 findings, all autofixable whitespace.
- `anti-slop/no-array-filter-map`: 15 findings.
- `anti-slop-effect/no-manual-tag-comparison`: 23 findings.
- `anti-slop-effect/prefer-effect-match`: 11 findings.
- `anti-slop-effect/no-manual-tagged-construction`: 9 findings.
