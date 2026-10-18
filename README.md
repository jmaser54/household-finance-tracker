# Our Household Money

A private, local-first household spending and income tracker. You import PDF bank and credit-card statements, and they are read **in your browser, on your computer**. The ledger stays in that browser. There is no server, no account, no bank connection, and no analytics.

> **Status: foundation (Phase 1).** Statement import, storage, backups and the real dashboard are not built yet. Do not use with real data until the release gate in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#10-release-gate-before-real-data-is-used) passes.

- **Source of truth:** [`PROJECT_PRINCIPLES.md`](PROJECT_PRINCIPLES.md). Read it before changing anything that touches data, storage, security or calculations.
- **Technical plan:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Development

Requires Node 22+.

```sh
npm ci            # install exact locked versions (install scripts disabled)
npm run dev       # local dev server
npm run verify    # typecheck, unit tests, repo hygiene, build, build privacy scan, browser network tests
```

Browser tests need Chromium: `npx playwright install chromium`.

**Never commit real statements, backups, exports or account details.** The `.gitignore` blocks them and `npm run check:repo` fails CI if any are tracked. Only synthetic fixtures under `tests/fixtures/synthetic/` are allowed.
