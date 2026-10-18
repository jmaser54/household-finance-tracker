# Architecture and Technical Plan

Companion to [`PROJECT_PRINCIPLES.md`](../PROJECT_PRINCIPLES.md). The principles define *what must be true*; this file defines *how we make it true*. If they ever disagree, the principles win and this file gets fixed.

## 1. Shape of the system

```
 GitHub Pages (code only)          The household's browser (all data)
 ┌──────────────────────┐          ┌───────────────────────────────────────────────┐
 │ index.html + CSP     │  static  │  UI (Preact)                                  │
 │ JS / CSS / worker    │ ───────► │   │                                           │
 └──────────────────────┘  files   │   ▼                                           │
          ▲                        │  Import pipeline ── PDF parser (pdf.js worker)│
          │ no requests back       │   │  stage → review → confirm (atomic)        │
          ✗ (connect-src 'none')   │   ▼                                           │
                                   │  Domain: dedupe · transfers · categorize ·    │
                                   │          calculations (pure, tested)          │
                                   │   ▼                                           │
                                   │  IndexedDB ledger ──► Encrypted backup file   │
                                   │                       (WebCrypto, passphrase) │
                                   └───────────────────────────────────────────────┘
```

The server only ever *sends* static files. The page has no code path that sends anything back, and the Content-Security-Policy blocks such a path even if one were added by mistake.

## 2. Options evaluated

| Concern | Options considered | Choice | Why |
|---|---|---|---|
| Hosting | GitHub Pages; Pages + custom domain; a desktop app (Electron/Tauri) | **GitHub Pages on a dedicated origin** | Matches your existing workflow and serves code only. A desktop app removes origin and hosting risks but adds signing, updates, and a large dependency tree. Revisit if web-delivery risk (principles §16.3) becomes unacceptable. |
| Build | No build step; Vite | **Vite + TypeScript** | Strict types catch money and sign errors. Vite outputs plain static files with relative paths. Dev-only dependency. |
| UI | Vanilla DOM; Preact; React | **Preact 10** | About 4 KB with **zero runtime dependencies**. Components keep the review screens maintainable. React adds weight for no benefit. Preact 11 is too new (weeks old) for a privacy-critical app. |
| Storage | localStorage; IndexedDB raw API; `idb`/Dexie wrapper | **IndexedDB, thin in-house wrapper** | localStorage is small and synchronous. IndexedDB gives atomic multi-store transactions, which the safe-import guarantee depends on. The wrapper is about 100 lines, so we avoid another data-touching dependency. |
| PDF text | pdf.js (`pdfjs-dist`); pdf-lib; WASM MuPDF | **pdf.js (planned for Phase 3)** | Mozilla's battle-tested, browser-native parser with positioned text runs (needed for column layouts) and no runtime dependencies. pdf-lib cannot extract text. MuPDF is AGPL and heavy. The worker is self-hosted; `isEvalSupported:false`, no remote fonts or cMaps. |
| OCR for scanned PDFs | Tesseract.js (local WASM); none | **None in v1** | Detect and explain instead. Local OCR is possible later, but is large and error-prone with money. |
| Encryption | WebCrypto AES-GCM + PBKDF2; libsodium/Argon2 (WASM) | **WebCrypto AES-256-GCM, PBKDF2-SHA-256 (D3)** | Built into the browser, so nothing to install and nothing to trust beyond the browser. Argon2id is stronger but adds a WASM dependency. |
| Tests | Vitest; Playwright | **Vitest (unit), Playwright (browser)** | Dev-only. Playwright proves real network behaviour in Chromium. |

Total runtime dependencies today: **1** (`preact`). Phase 3 adds `pdfjs-dist`. Any further runtime dependency needs a line in the [dependency register](#9-dependency-register).

## 3. Security controls

- **CSP (meta tag):** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'`. No `unsafe-inline` and no `unsafe-eval`. The dev server alone relaxes it for hot reload (`vite.config.ts`, serve-only plugin).
- **Referrer:** `no-referrer`. **Robots:** `noindex`.
- **URLs carry no state.** Navigation is in-memory, and the URL never contains data.
- **No logging.** The source guard test forbids `console.*` in app code. Global error handlers show a generic banner and swallow details.
- **Supply chain:**
  - exact pins and a lockfile,
  - `ignore-scripts=true`,
  - `npm ci` in CI,
  - Actions pinned to commit SHAs,
  - deploy is manual (`workflow_dispatch`).

### Origin isolation (blocking decision D1)

IndexedDB, and every other kind of browser storage, is scoped to the **origin** (scheme + host + port), not the path. `https://jmaser54.github.io/household-finance-tracker/` and `https://jmaser54.github.io/any-other-project/` are the **same origin**. Script on any of your other Pages projects could open this app's database. Two ways to fix it:

1. **Custom subdomain** for this repository only, such as `money.example.com`, with HTTPS enforced in the Pages settings. Do not reuse a domain that hosts anything else.
2. **Dedicated GitHub organization** (free), for example `jmaser-household`, hosting only this repository. Its Pages origin `https://jmaser-household.github.io` is then unique.

The build uses relative paths, so it works under either option without changes.

## 4. Data model (schema v1 draft)

Types live in `src/domain/types.ts`; the default taxonomy is in `src/domain/categories.ts`.

- **Account:** display name, kind (checking/savings/credit card), institution, optional last four digits, parser id, archived flag.
- **Statement:** account, period start and end, opening and closing balances, PDF SHA-256, parser id and version, transaction count, validation results, import batch.
- **Transaction:**
  - account and statement ids,
  - posted and transaction dates,
  - signed integer `amountCents`,
  - `originalDescription` (immutable) and `merchant` (normalized, editable),
  - `kind`,
  - `classification` (category, source, confidence, reasons),
  - optional `splits`, `transferGroupId`, `refundOfTransactionId`,
  - `needsReview`, `note`, `dedupeKey`.
- **Category:** kind `expense | income | transfer`, optional single-level parent, `prominent`, `builtIn`.
- **CategorizationRule:** a match (contains/equals on description or merchant, optionally scoped by account, direction, and amount range) and actions (merchant, category, kind). User-supplied regular expressions are not allowed: they are fragile and a ReDoS risk.
- **Import batch:** staged data held apart from the ledger until confirmed.

**Sign convention:** negative means money out or debt up; positive means money in or debt down, from the household's view. Parsers convert each issuer's printed signs.

**Recognition rules for calculations (Phase 2):**
- A transaction counts as **expense** or **income** by its category kind. If it has splits, each split counts by its own category's kind.
- Kinds `transfer` and `card_payment` are always excluded, whatever the category.
- A **refund** linked to a purchase posts to that purchase's expense category as a negative expense, which reduces spending. An unlinked refund is flagged for review. Its proposed category is Refunds & Reimbursements income; it is never auto-classified as employment income.
- **Net cash flow** = Σ recognized income − Σ recognized expenses.

**Transfer matching (Phase 2):** pairs opposite-signed, equal-magnitude transactions in two different household accounts within a short date window (for example ±5 days). Description hints ("PAYMENT", "TRANSFER", the last four digits of the other account) raise confidence. Ambiguous matches, such as two candidate pairs, go to review instead of being guessed. A card payment whose matching side is outside the imported range is still classified as a card payment by kind.

## 5. Import pipeline and duplicate detection (Phase 3)

1. **Read** each file locally, then:
   - compute its SHA-256,
   - extract positioned text with pdf.js in a worker,
   - classify it as text-based or image-only (scanned) by text-run density. Image-only files are flagged as unsupported.
2. **Detect layout:** each registered parser scores how well it recognises the document. The best match parses it; if no parser is confident, the file is flagged as an unsupported layout. Parsers are pure functions from text runs to a statement candidate, and are independently testable.
3. **Validate:**
   - opening balance + activity = closing balance,
   - printed totals and counts vs. extracted ones,
   - all dates inside the statement period,
   - every amount parses (amount parsing never guesses; `src/domain/money.ts`).
4. **Stage** the candidates in the import batch, separate from the ledger.
5. **Deduplicate** against the ledger and the rest of the batch:
   - *Same file:* the SHA-256 already exists, so it is flagged as already imported.
   - *Same account and overlapping period:* within the overlap, transactions are compared as **multisets** keyed by `(account, posted date, amount, normalized description)`. If the ledger already has *n* matches and the incoming statement has *m*, only `max(0, m − n)` are new. Two legitimate identical coffees on one day survive, and re-imports add nothing.
   - Near-matches (same amount, a date off by one or two days, or a differing description) are flagged for review, never merged silently.
6. **Classify** with the current rules and heuristics, attach confidence and reasons, and flag low-confidence items.
7. **Review screen:** per statement, show its validation, new and duplicate counts, and flagged rows. The user can fix things, then confirm or discard.
8. **Commit** in a single IndexedDB transaction. If anything fails, nothing is written. Each batch records what it added, so an import can be undone.

## 6. Refining parsers without sharing statements

- Parsers are developed against **synthetic PDFs** generated in the test suite. These mimic each layout's *structure* (columns, headings, date formats, sign conventions, multi-line descriptions, page breaks) using invented merchants and amounts.
- When a real statement does not parse correctly, the app's **local diagnostics panel** shows *structural* information on screen only, without copying anything anywhere:
  - which parser was tried and why it was or wasn't confident,
  - which validation failed,
  - line shapes such as `DATE  TEXT  AMOUNT`, with values masked.
- You can describe the structure in your own words, or copy the masked shape summary. That lets a developer (or Claude) write a matching synthetic fixture and parser change without ever seeing the real document.
- The final accuracy check against real statements happens in your browser, using the validation results on the review screen.

## 7. Backup format (Phase 4)

- A single file, `household-YYYY-MM-DD.hhbackup`.
- **Plaintext header:** format name and version, KDF and parameters (salt, iterations), cipher, and IV. The header contains no financial data, counts, or dates of transactions.
- **Payload:** JSON with all stores plus schema version, compressed and then encrypted with AES-256-GCM. The header is bound in as additional authenticated data, so editing it makes decryption fail.
- **Restore steps:**
  1. Pick the file.
  2. Enter the passphrase.
  3. Decrypt and validate (schema, ids, referential integrity, split sums).
  4. See a summary.
  5. Choose "replace", with an explicit confirmation.
  6. The restore happens in a single transaction.
  7. Before replacing, the app offers to download an encrypted backup of the current data.
- **Tests:** round-trip, wrong passphrase, truncated file, modified ciphertext, modified header, older-schema migration.

## 8. Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **1. Foundation** *(this change)* | Principles, architecture, scaffold, CSP, privacy guard tests, money utilities, draft types and taxonomy, welcoming landing page with an illustrative preview | Typecheck, unit tests, hygiene check, build, build scan, and browser network tests all pass |
| **2. Model and calculations** | Finalize schema v1; pure functions for recognition, net cash flow, transfer matching, refund linking, splits, multiset dedupe, catch-all share metric | Tests for every definition in principles §10 and the cases in §14 |
| **3. Import** | pdf.js integration and review; parser interface; scanned-PDF detection; 2–3 synthetic layouts generated in tests; staging and review UI; local diagnostics | Malformed, scanned, overlap, re-import, and validation-failure tests; no network access during parsing |
| **4. Persistence and backups** | IndexedDB wrapper and migrations; atomic commit and undo; encrypted backup and restore; persistent-storage request; decide D2 and D3 | Backup round-trip, tamper, and wrong-passphrase tests; restore never leaves partial data |
| **5. Dashboard** | Overview (in/out/kept), spending by category, incoming-money section, period comparison, drilldowns, review queue, catch-all quality nudge, backup reminder | Totals traceable to transactions; tests for calculations shown |
| **6. Validation and release** | Accessibility pass, end-to-end flow on synthetic data, release gate | Release gate below passes; D1 resolved |

## 9. Dependency register

| Package | Runtime? | Touches financial data? | Network behaviour | Notes |
|---|---|---|---|---|
| preact 10.29.8 | Yes | Renders it | None | Zero dependencies |
| vite, vitest, typescript, @playwright/test, @types/node | Dev only | Synthetic data only | Not shipped | Never included in `dist/` |

## 10. Release gate (before real data is used)

- [ ] D1 resolved: the app is served from an origin that hosts nothing else, over HTTPS.
- [ ] GitHub account has 2FA; `main` is branch-protected; deploys are manual.
- [ ] `npm run verify` passes on the release commit.
- [ ] The deployed site was loaded with devtools open: only its own static files were requested, and no CSP violations or console output appeared.
- [ ] Encrypted backup and restore are implemented and their tests pass. A backup has been restored in a second browser profile as a migration rehearsal.
- [ ] User-facing help states the residual risks in plain language (principles §16).
