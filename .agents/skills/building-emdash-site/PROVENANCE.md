# Provenance

This skill is vendored, unmodified, from the official EmDash repository.

- Upstream repository: https://github.com/emdash-cms/emdash
- Upstream path: `skills/building-emdash-site/`
- Pinned ref: tag `emdash@1.0.1`
- Pinned commit SHA: `0e8977c221dd8e5111511eb226faa3d164c829ef`
- Source URL base: https://raw.githubusercontent.com/emdash-cms/emdash/0e8977c221dd8e5111511eb226faa3d164c829ef/skills/building-emdash-site/
- License: MIT (Copyright 2026 Cloudflare Inc.) - see `LICENSE` in this directory.

## Vendored files and upstream SHA-256

| File                              | SHA-256                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| SKILL.md                          | f356c5ad1595887b211f3ef1804799b0aba0320ee8db7a5759acf588b9f56054  |
| references/configuration.md       | 0412e73da7f28d20a2933e282a3e5d42cae5f5726b5c1308871453f2b4bd2f39  |
| references/querying-and-rendering.md | 1d7e9578d854d77b32ea5ead74bccda0f42d07c823aee7cbb8c7627c9cb822f7 |
| references/schema-and-seed.md     | 9ba257a19fb8134bb927a2cfdb8b8195819b269ddc704b106ba76124b29ce549  |
| references/site-features.md       | 9ee26c73a92877357a8dc686d5b40b97ac175628ca3be98e852f6ac39c23ab11  |

Verify a file with: `shasum -a 256 <file>` and compare against the table above.

## Refresh procedure

To re-vendor from a newer upstream tag, replace every file above with the
contents at the new pinned SHA, recompute the SHA-256 values, and update this
file. Do not hand-edit the skill files themselves.
