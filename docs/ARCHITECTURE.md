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

### Limits of a meta-tag CSP on GitHub Pages

GitHub Pages cannot send response headers, so the policy is delivered in a `<meta>` tag. Known gaps:

- **Ignored in meta tags:** `frame-ancestors`, `sandbox`, and reporting (`report-uri`/`report-to`). There is no clickjacking header, and violations are not reported anywhere. Nothing is reported to us, which is fine, because we would not want reports anyway.
- **Timing:** the policy applies only from the point where the tag is parsed. Nothing loads before it in `index.html`, and `check-build-output.mjs` rejects inline scripts.
- **Navigation:** CSP cannot stop script from navigating the top-level page to another site with data in the URL. Only trustworthy code prevents that, so the supply-chain controls above matter.
- **Delivery:** a malicious deploy can ship a different policy. The CSP protects against mistakes and injected content, not against whoever controls the deployed code (principles §16.3).

### Origin isolation (blocking decision D1): recommendation, awaiting approval

IndexedDB, and every other kind of browser storage, is scoped to the **origin** (scheme + host + port), not the path. `https://jmaser54.github.io/household-finance-tracker/` and `https://jmaser54.github.io/any-other-project/` are the **same origin**, so script on any of your other Pages projects could open this app's database.

**Recommendation:** a **free GitHub organization used only for this app**, for example `<your-choice>-household`. Transfer this repository into it, and enable Pages on this repository only. The app is then served from `https://<org>.github.io/household-finance-tracker/`, an origin that nothing else of yours shares.

| Option | Isolation | Cost / effort | Verdict |
|---|---|---|---|
| **Dedicated GitHub organization** | Own origin, `<org>.github.io` | Free for public repositories; about 10 minutes in the GitHub web UI | **Recommended** |
| Buy a domain and use a subdomain | Own origin | About $10–20/year, DNS setup, renewals. A lapsed domain or dangling DNS record can be taken over. | Good, but unnecessary now |
| Second personal GitHub account | Own origin | GitHub's terms limit people to one free personal account | Rejected |
| Rename this repository to `jmaser54.github.io` | **None**: still the same origin as your other projects | — | Rejected |
| Run it locally (`localhost` or `file://`) | `localhost` is shared with any other local dev server; `file://` storage behaviour differs between browsers | Requires running a server; not approachable | Rejected |

*Unverified facts:* the following could not be checked against GitHub's documentation from this sandbox, because docs.github.com is unreachable here. Confirm them when you create the organization.
- Pages is free for public repositories on "GitHub Free for organizations".
- An organization's project site URL is `https://<org>.github.io/<repo>/`.
- Repository transfer keeps history and issues, and creates redirects.
- `github.io` is on the Public Suffix List, so `<org>.github.io` is also a separate *site* for cookie and storage-partitioning purposes, not just a separate origin.

**Trade-offs and rules that come with the organization:**
- The repository must be **public** for free Pages. It contains only code, never data, so this is acceptable. Code review by anyone is a mild benefit.
- **Never enable Pages on any other repository in this organization**, and never give the organization a custom domain. Any second Pages site would share the origin again. Keep yourself as the only owner, and require 2FA for the organization.
- The organization's name appears in the app's URL.
- After the transfer, the Claude GitHub app must be installed on the organization for future sessions to reach the repository.

**Proposed steps.** You do steps 1–4 in the GitHub web UI; I do step 5.
1. Create the organization on the Free plan.
2. Turn on *Require two-factor authentication* in the organization settings.
3. Transfer `jmaser54/household-finance-tracker` to the organization (Settings → Danger zone → Transfer).
4. Install or authorize the Claude GitHub app for the organization. Set Pages → Source to **GitHub Actions**. Do not run the deploy workflow yet.
5. I add the **runtime origin guard** with the organization's origin, plus the isolation tests below. Then you run the manual deploy and we check the live site together.

**How isolation will be verified, not assumed:**
- **Runtime origin guard.** The expected origin is fixed at build time. The app refuses to create or unlock the vault on any other origin, apart from `localhost`/`127.0.0.1` during development, where it shows a visible "development copy" banner. An e2e test serves the build on a non-matching origin and asserts the guard blocks it.
- **Cross-origin storage test.** An e2e test writes a marker to IndexedDB on origin A (`127.0.0.1`) and asserts that a page on origin B (`localhost`) cannot see the database at all. This proves the browser behaviour we rely on, in the browser we test with.
- **Post-deploy check (manual):**
  - the live URL's origin is `https://<org>.github.io`;
  - no other repository in the organization has Pages enabled;
  - the browser network panel shows only same-origin static files and no CSP violations.
- **Limitation:** no automated test can stop someone from enabling Pages on another repository in the organization later. That is an organizational rule, recorded here and in the release gate.

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

## 7. App lock / encrypted vault (D2 decided; design awaiting approval)

The household decided (2026-10-19) that a passphrase is required to unlock locally stored financial data.

**Design (standard envelope encryption, no custom cryptography):**
1. **Setup.**
   - You choose a household passphrase.
   - The app generates a random 256-bit **data key**, using `crypto.subtle.generateKey`.
   - It derives a **key-encryption key** from the passphrase with Argon2id (D3), using a random 16-byte salt.
   - It wraps (encrypts) the data key with that key, using AES-256-GCM.
   - Only the **wrapped** data key, the salt and the KDF parameters are stored. The passphrase and the key-encryption key are never stored anywhere.
2. **Unlock.**
   - The app derives the key-encryption key again, in a Web Worker so the page stays responsive.
   - It unwraps the data key into a **non-extractable** `CryptoKey` held only in memory.
   - A wrong passphrase fails the GCM authentication check and produces a friendly "That passphrase didn't open it".
3. **Storage.**
   - The whole ledger is serialized to JSON, compressed, and encrypted with the data key using AES-256-GCM, with a fresh random 96-bit IV for each save.
   - It is stored in IndexedDB as one record, alongside the previous generation for crash recovery.
   - The format version and generation number are bound in as authenticated data, so records cannot be swapped or rolled back unnoticed.
   - One IndexedDB transaction per save makes every save atomic.
   - **Why one encrypted document rather than encrypting record by record:** it reveals only the total size, not how many transactions or accounts there are. It also makes atomic import commits, migrations and backups simple.
   - **Size:** about 10k transactions per year is roughly 2–3 MB, which encrypts in milliseconds. If it ever becomes slow, we can split it into per-year segments without changing the security model.
4. **Locking.**
   - Triggers: a "Lock" button, and inactivity (default 15 minutes, adjustable).
   - Locking drops every reference to the data key and the decrypted ledger, then shows the unlock screen.
   - JavaScript cannot guarantee that memory is wiped. A non-extractable `CryptoKey` keeps the raw key away from page script.
5. **Changing the passphrase** only re-wraps the data key. Data is not re-encrypted.
6. **No passphrase, no data.** The data key is never stored unwrapped, never put in `localStorage` or `sessionStorage`, and never cached across reloads. Reloading the page means unlocking again.

**What it protects against:**
- Someone opening the browser while the app is locked.
- A copy of the browser profile or disk: a stolen laptop without disk encryption, profile backups, synced profile folders.
- Other operating-system users who can read the files.
- Other websites. Origin isolation (D1) also covers this.

**What it does NOT protect against:**
- Anyone using the computer while the app is unlocked.
- Malware or keyloggers on the computer.
- Malicious browser extensions. They can read the page and capture the passphrase as it is typed.
- A compromised deployment of the app's code, which would receive the passphrase at the next unlock.
- Offline guessing of a **weak** passphrase.
- Someone watching the passphrase being typed.
- **Deletion.** Anyone can clear site data. That destroys the data rather than exposing it, so backups still matter.

**Recovery limitations:**
- A forgotten passphrase makes the local data **permanently unreadable**. There is no reset and no back door, by design.
- The recovery path is an encrypted backup (§8) plus its passphrase.
- The app will say this plainly at setup, and the backup reminder exists for exactly this reason.

**Passphrase guidance:** the app offers to suggest a passphrase of random common words (five words from the EFF large wordlist, about 64 bits of entropy). It requires at least 12 characters, and rejects very common passwords using a small built-in list. The guidance is phrased warmly, not as a lecture.

## 8. Key derivation and backups (D3): recommendation, awaiting approval

**Candidates evaluated.** Timings are from Node 22 (V8, the same JavaScript engine as Chrome) on the build server. In a browser they will differ.

| Implementation | Algorithm | Time (m=64 MiB, t=3) | Dependencies | CSP impact | Maintenance and assurance |
|---|---|---|---|---|---|
| **`@noble/hashes` 2.4.0** | Argon2id (RFC 9106) | ≈ 1.3–1.5 s | 0 | **None** (pure JS) | Actively maintained (last release Aug 2026). The library is Cure53-audited, **but its Argon2 module is explicitly outside that audit**. Passes the RFC 9106 test vector. |
| `hash-wasm` 4.12.0 | Argon2id | ≈ 0.26 s | 0 | **Requires `'wasm-unsafe-eval'`** (loosens CSP) | Last release Nov 2024; no audit known |
| `argon2-browser` 1.18.0 | Argon2id | — | — | Requires WASM | **Unmaintained since 2021**; rejected |
| WebCrypto PBKDF2-SHA-256, 600k iterations | PBKDF2 | ≈ 0.1 s | Built in | None | The browser's own implementation; most mature. **Not memory-hard**, so GPU guessing is far cheaper. |

**Recommendation:** **Argon2id via `@noble/hashes`**, with m = 64 MiB, t = 3, p = 1, running in a Web Worker. Encryption uses **AES-256-GCM via WebCrypto**. The same scheme serves the app lock and backups.

**Why Argon2id justifies one small dependency.**
- The realistic attack on this design is *offline guessing* against a stolen backup file or browser profile.
- Argon2id makes each guess cost 64 MiB of memory, which cuts the guessing rate of GPUs and other specialised hardware by orders of magnitude compared with PBKDF2. This is a qualitative estimate, not measured here.
- That margin matters most for human-chosen passphrases.
- The dependency adds no runtime network access, no WASM, and no CSP change.

**Managing the unaudited Argon2 module:**
- Pin the exact version.
- Unit-test against the RFC 9106 test vector.
- Cross-check against an **independent implementation** (`hash-wasm`, installed as a *dev-only* dependency and run only in Node tests, never shipped) on many random inputs.
- Review the module's source once and record the review in the dependency register.
- An implementation bug would almost certainly show up as wrong output, which these tests catch, rather than as quietly weaker security. That is a judgement, not a proof.

**Fallback:** if you would rather ship only audited code, use PBKDF2-SHA-256 at 600,000+ iterations. It is simpler and fully native, but weaker against offline guessing. The KDF name and parameters are stored in every file header, so we can move between KDFs, or to native WebCrypto Argon2 if browsers ship it, without breaking old files.

**Backup file format.** One file, `household-YYYY-MM-DD.hhbackup`.
- **Plaintext header:** format and version; KDF name, parameters and salt; cipher and IV. It contains no financial data, counts or dates.
- **Payload:** the same ledger JSON as the vault plus its schema version, compressed, then encrypted with AES-256-GCM. The key is derived with Argon2id from the backup passphrase and a fresh salt for each file. The header is bound in as authenticated data, so editing it makes decryption fail.
- **Never unencrypted.** Encryption happens before the file is offered for download. The app has no code path that writes an unencrypted export.
- **Portability:** the format is documented, so a backup can be decrypted with standard tools (any RFC 9106 Argon2id plus AES-GCM implementation). We will include a tested reference recipe so that decryption does not depend on this app staying online.

**Restore steps:**
1. Pick the file and enter its passphrase.
2. The app decrypts it and validates the schema, ids, referential integrity and split sums.
3. You see a summary of what the file contains.
4. Before anything is replaced, the app offers to save an encrypted backup of the current data.
5. You explicitly confirm "replace".
6. The replacement happens in a single transaction, or not at all.

**Tests (Phase 4):**
- vault set up, lock and unlock;
- wrong passphrase;
- tampered ciphertext, IV, header or generation number;
- rollback to an older generation;
- passphrase change;
- KDF-parameter round-trip;
- backup round-trip;
- wrong backup passphrase;
- truncated or corrupted file;
- older-schema migration;
- a restore that fails part-way leaves existing data intact;
- the decrypted ledger and keys never reach logs, URLs or network (the existing guards plus e2e network capture during unlock and backup);
- the data key is non-extractable.

## 9. Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **1. Foundation** *(this change)* | Principles, architecture, scaffold, CSP, privacy guard tests, money utilities, draft types and taxonomy, welcoming landing page with an illustrative preview | Typecheck, unit tests, hygiene check, build, build scan, and browser network tests all pass |
| **2. Model and calculations** *(done)* | Pure functions for recognition, net cash flow, transfer matching, refund linking, splits, multiset dedupe, catch-all share metric (`src/domain/`) | Tests for every definition in principles §10; mutation-checked |
| **3. Import** | pdf.js integration and review; parser interface; scanned-PDF detection; 2–3 synthetic layouts generated in tests; staging and review UI; local diagnostics | Malformed, scanned, overlap, re-import, and validation-failure tests; no network access during parsing |
| **4. Vault and backups** | After D1–D3 approval: origin guard; encrypted vault (§7); Argon2id worker; atomic commit and undo; encrypted backup and restore (§8); persistent-storage request | Backup round-trip, tamper, and wrong-passphrase tests; restore never leaves partial data |
| **5. Dashboard** | Overview (in/out/kept), spending by category, incoming-money section, period comparison, drilldowns, review queue, catch-all quality nudge, backup reminder | Totals traceable to transactions; tests for calculations shown |
| **6. Validation and release** | Accessibility pass, end-to-end flow on synthetic data, release gate | Release gate below passes; D1 resolved |

## 10. Dependency register

| Package | Runtime? | Touches financial data? | Network behaviour | Notes |
|---|---|---|---|---|
| preact 10.29.8 | Yes | Renders it | None | Zero dependencies |
| vite, vitest, typescript, @playwright/test, @types/node | Dev only | Synthetic data only | Not shipped | Never included in `dist/` |

## 11. Release gate (before real data is used)

- [ ] D1 resolved: the app is served from an origin that hosts nothing else, over HTTPS. The runtime origin guard is configured for it, and no other repository in the organization has Pages enabled.
- [ ] The app lock is implemented and its tests pass (§7).
- [ ] GitHub account has 2FA; `main` is branch-protected; deploys are manual.
- [ ] `npm run verify` passes on the release commit.
- [ ] The deployed site was loaded with devtools open: only its own static files were requested, and no CSP violations or console output appeared.
- [ ] Encrypted backup and restore are implemented and their tests pass. A backup has been restored in a second browser profile as a migration rehearsal.
- [ ] User-facing help states the residual risks in plain language (principles §16).
