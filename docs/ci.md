# CI and local Worker smoke coverage

The repository CI workflow runs on pull requests and pushes to `main`. It uses
Bun and performs a frozen install, seed validation, generated type/schema drift
validation, the full test suite, type-checking/linting, a production build, a
dependency audit, and whitespace/diff hygiene checks.

## Local Worker smoke test

Run:

```bash
bun run smoke:worker
```

This command builds the Worker, then starts the built SSR entrypoint with the
same local bindings flow as `bun run cf:dev`. It does not deploy, contact
Cloudflare, require credentials, or use a remote binding. The smoke runner:

- chooses an ephemeral local port instead of assuming a fixed port;
- creates a temporary Wrangler configuration with only simulated D1, R2, and
  KV bindings, and filters inherited provider/deployment credentials;
- supplies a temporary bootstrap secret only to the local Worker;
- checks the uninitialized setup boundary, including unauthenticated denial,
  invalid-token denial, and the valid bootstrap redirect to the clean setup URL;
- requires HTTP 200 from `/`, `/robots.txt`, `/sitemap.xml`, and
  `/_emdash/api/search` against the empty local D1 database;
- separately verifies that setup returns the deliberate HTTP 503 boundary when
  the CMS database binding is unavailable; and
- shuts down the owned Worker process group, releases its port, and removes
  temporary state/configuration after failures or interruption.

The smoke run passes Wrangler an isolated temporary `--persist-to` directory.
It never reads from or writes to the repository's `.wrangler/state` directory.
To inspect or reset ordinary local development data, continue to use the
documented `bun run cf:dev` workflow separately.
