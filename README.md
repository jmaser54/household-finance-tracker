# Household Money

A private household spending and income tracker, built as a **standalone Mac app** (Tauri). Bank and credit-card statement PDFs are read on your Mac, and every record, calculation and backup stays there, encrypted with your passphrase. There are no accounts, no cloud services, no bank connections, and no network requests during normal use.

> **Status:** the UI foundation and the tested financial calculations exist. The Mac app shell, encrypted storage, backups and PDF import are planned and not yet built. Do not use with real data until the go-live checklist in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#14-household-go-live-checklist-before-real-statements) passes.

- **Source of truth:** [`PROJECT_PRINCIPLES.md`](PROJECT_PRINCIPLES.md). Read it before changing anything that touches data, storage, security or calculations.
- **Architecture and plan:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Development

Requires Node 22+.

```sh
npm ci            # install exact locked versions (install scripts disabled)
npm run dev       # UI dev server (synthetic/illustrative data only)
npm run verify    # typecheck, unit tests, repo hygiene, build, build privacy scan, browser network tests
```

Browser tests need Chromium: `npx playwright install chromium`.

**Never commit real statements, data files, backups, exports or account details.** The `.gitignore` blocks them, and `npm run check:repo` fails CI if any are tracked or have ever appeared in Git history. Only synthetic fixtures under `tests/fixtures/synthetic/` are allowed.
