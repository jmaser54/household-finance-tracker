# Project Principles — Household Finance Tracker

**Status:** Canonical, living source of truth for product, privacy, security, and financial-correctness requirements.
**Supersedes:** `docs/reference/household-finance-product-and-security-principles.md` (kept for history only; do not edit or develop against it).
**Last reviewed:** 2026-10-19 (v1.1, financial calculations; D2 decided)

## How to use this document

- Read the relevant sections **before** implementing anything that touches privacy, data storage, security, imports, backups, or financial calculations.
- When requirements change, change them **here** and record the change in the [change log](#change-log). There is exactly one principles document. Do not create competing copies.
- Precedence: **§1 privacy overrides everything else.** Next come financial correctness (§10–§12), then approachability (§5). Feature count comes last.
- "Must" and "never" are non-negotiable. Weakening one requires the household user's explicit approval, recorded in the change log. Silent reinterpretation is not allowed.
- If a requirement cannot be met, stop and say so. Do not ship a weaker version that looks like it meets the requirement.

---

## 1. Rule number one: financial data is accessible only to the household user

> **Financial data must be accessible only to the household user.** Never expose financial statements, transactions, account information, or derived financial data (balances, categories, summaries, merchant history) to other users or unauthorized parties.
>
> **If we cannot implement a reasonable, defensible security architecture, do not ship the application.**

This applies to every artifact the project produces: the running app, its storage, backups, the source repository, CI, logs, test fixtures, screenshots, and conversations with AI coding tools.

The application must never expose one household user's data to another user of the app. Each browser origin holds only its own household's data, and nothing is shared.

## 2. Honesty about security

- Our job is to **minimize** risk and **document what remains**. No application can promise a zero percent chance of compromise, and we never claim one.
- Make only claims that are true of the implementation **and have been verified**, for example by a test or an inspected network log. Acceptable: "Statements are read on this computer and are not uploaded by this app." Not acceptable: "Bank-level security", "100% secure", "unhackable", "your data can never leak".
- Browser storage is **not** automatically encrypted storage. Never describe it as encrypted, private from other people using the same computer account, or permanent.
- Never call a backup encrypted unless encryption is implemented, tested (including wrong-passphrase and tamper tests), and actually applied to that file.
- Known residual risks are listed in [§16](#16-residual-risks-we-accept-and-document) and must be kept current.

## 3. Privacy and security requirements

### 3.1 Architecture boundary

- **Local-first.** Statements are processed on the user's device, in the browser. The household ledger is stored in that browser's local database (IndexedDB).
- **GitHub Pages hosts application code only.** It is never a store for financial data, in any form.
- **No backend.** No backend, login service, cloud synchronization, server-side processing, or third-party data processing without the household user's **explicit approval** recorded in the change log.
- **No bank connections.** No connections to banks or financial aggregators. Bank login credentials are never requested or stored.
- **No data leaves the device.** Statements, transaction data, descriptions, balances, account details, categories, and financial summaries are never transmitted to any server or third-party service. This includes:
  - remote AI APIs,
  - external OCR,
  - analytics and telemetry,
  - error-reporting services,
  - CDNs that receive data,
  - web fonts or other remote resources that reveal app usage.
- **Network isolation is enforced, not just intended.** The shipped page carries a Content-Security-Policy with `connect-src 'none'` and `default-src 'none'`, plus `no-referrer`. Automated tests verify the built app makes no requests except for its own static files, and that the policy blocks outbound connections.
- **Origin isolation is required before real data is imported.** Browsers isolate IndexedDB per *origin*. All GitHub Pages project sites under one account share one origin (`https://<user>.github.io`), so any other project hosted there could read this app's data. The app must run on an origin that hosts nothing else, such as a dedicated custom subdomain or a dedicated GitHub organization. See [§17](#17-open-decisions).

### 3.2 Data handling inside the app

- **Never** include financial data in:
  - error messages that are sent anywhere,
  - console output,
  - URLs (path, query, or hash),
  - page titles,
  - browser history,
  - analytics,
  - diagnostic logs.
- The app has no logging or error-reporting pipeline at all. Unexpected errors show a generic message on screen.
- Small key/value storage (`localStorage`, `sessionStorage`, cookies) is not used for financial data.
- Only the **last four digits** of an account number may be stored, and only to match statements to accounts. Full account numbers are discarded after parsing.
- Original PDF files are **not** stored in the app. Only a SHA-256 fingerprint is kept, to detect repeat imports.

### 3.3 Dependencies and supply chain

- Minimize dependencies and external scripts. No third-party scripts are loaded at runtime from any CDN: everything ships from the app's own origin.
- Any dependency that can read imported files or transaction data (for example the PDF parser) needs an explicit review. Record its purpose, version, and network behaviour in `docs/ARCHITECTURE.md`.
- Pin exact versions with a lockfile, and install with `npm ci`. Install scripts are disabled by default (`.npmrc`). Pin GitHub Actions to commit SHAs.
- Prefer mature releases over brand-new ones for anything that touches data.

### 3.4 Source control, CI, and AI tooling

- **Never** put any of the following into GitHub, source control, CI logs, test snapshots, screenshots, or test artifacts:
  - statements (including redacted ones),
  - transaction data,
  - merchant histories,
  - account numbers,
  - backups or exports,
  - credentials or passphrases,
  - any other private household information.
- Only **synthetic** fixtures, generated by scripts in this repository, may be used for development, automated tests, and CI. Merchant descriptions and transaction patterns are themselves sensitive. Avoid redacted real samples in the repository.
- **Real statements are selected and processed only inside the finished app, in the household's own browser.** AI coding assistants (including Claude Code) must never request, upload, inspect, or receive real statements or transaction records. The app must never depend on sending real documents to Claude or any other external service. Using a third-party service for this would require the household user's explicit, informed decision, recorded in the change log.
- Parser accuracy against real formats is checked by the household user, locally, using in-app diagnostics that never leave the browser. See `docs/ARCHITECTURE.md`, "Refining parsers without sharing statements".
- CI must not upload screenshots, videos, or traces.
- **Git history is permanent.** Deleting a file in a later commit does not remove it from history, forks, or clones. The hygiene check scans every path ever added in history, not just current files. If private data were ever committed, treat it as exposed: rewrite history *and* assume copies exist.

## 4. Product goal and scope

Build a household **spending and income tracker** for a married couple who treat their finances as fully joint, even though they hold separate accounts. The initial target is one household, one computer, and one browser.

- Keep the architecture adaptable for future sharing and future households. Do **not** build multi-user accounts, a financial-data backend, or cloud sync now.
- Future households must be able to set up their own historical baseline and keep it current through regular imports. Account names, owners, and categories are **settings**, never hardcoded personal details.
- **Not in scope for the initial version:**
  - investments,
  - bill payment,
  - bank linking,
  - debt-payoff planning,
  - mandatory budgets.
- Monthly budgets may be considered later. They must never be required.
- **PDF statements only** in the first version.

## 5. User experience and visual direction

- Optimize for clarity, confidence, and approachability over feature count.
- **Tone:** warm, friendly, patient, and lightly playful, inspired by the welcoming, cartoonish feel of early-1990s *Backyard Baseball*.
  - Do not copy the game.
  - Do not make the interface childish, patronizing, cluttered, or gimmicky.
  - Never sacrifice clarity or accuracy for decoration.
- It should feel like a friendly place to explore our finances, not accounting software.
- **Avoid:**
  - overwhelming dashboards and walls of figures,
  - excessive decimals,
  - unnecessary tabs,
  - widget builders,
  - dense or numerous charts,
  - accounting jargon,
  - complicated setup.
- **Initial screen:**
  - a clear upload area for statement PDFs,
  - a small, attractive preview of the dashboard, built from fictional data that is clearly labelled as illustrative,
  - minimal explanatory text.
- **No** marketing homepage, lengthy onboarding, product tour, demo workflow, or unnecessary terms-of-service page.
- After importing and confirming statements, take the user **directly to the updated dashboard**.
- Use progressive disclosure: a simple overview first, with deeper detail through simple drilldowns.
- **Always make these obvious:**
  - what has been imported,
  - what needs review,
  - whether an import succeeded,
  - when data was last backed up.
- Backup reminders should be useful but unobtrusive.
- Summary figures are rounded to whole dollars. Exact cents appear in transaction lists and review screens.

## 6. Setup and ongoing imports

- **Initial setup:** about six months of historical statements establish history, recurring transactions, merchant mappings, and initial rules. For this household that means five accounts (Julia's checking, Julia's credit card, Jeff's checking, Jeff's savings, Jeff's credit card) × six months, or about 30 PDFs. These are examples of user-entered settings, not hardcoded values.
- **Ongoing:** upload the previous month's statements. If months were missed, multiple months can be uploaded at once.
- **Every import must:**
  - preserve existing history, user corrections, and rules,
  - detect overlapping statement periods,
  - never create duplicate transactions.

## 7. Statement import and PDF parsing

- Parse PDFs **in the browser only**. Never transmit PDFs for extraction or OCR.
- Detect text-based PDFs. Identify scanned or image-only PDFs and explain clearly that they are not supported yet. Never guess or claim success.
- Use **modular parsers** per statement layout (institution and format), behind a common interface. Never hardcode one bank's format throughout the app.
- Extract, where available:
  - transaction and posted dates,
  - descriptions,
  - amounts,
  - transaction types,
  - account identity (last four digits),
  - statement period,
  - opening and closing balances or summary totals.
- **Preserve the original description** exactly as printed, alongside the normalized merchant name.
- Validate extracted transaction counts, statement totals, and balances when the statement provides them. Show the result.
- Flag uncertain extraction, unsupported layouts, unreadable PDFs, and missing data.
- **Never silently omit transactions or invent data.**
- **Always show a review screen before committing.** Importing (staging) is separate from confirming and saving. A failed or cancelled import must not change the existing ledger. Confirmation is applied atomically.
- Detect duplicate transactions and overlapping statement periods, and recognise when the same PDF is imported again.
- Keep imports reversible where practical, and show clearly what will be added or changed.
- We do not assume every PDF can be parsed perfectly.

## 8. Storage, backup, and recovery

- The ledger lives in **IndexedDB**. Browser storage is tied to one device, browser, and origin, and it **can be deleted** (by clearing site data, browser storage eviction, a profile reset, or a new computer).
- **IndexedDB is not a backup.** Explain this clearly to the user, and request persistent storage where the browser supports it.
- **Backups must include:**
  - the complete financial dataset,
  - accounts and settings,
  - categories,
  - merchant mappings and rules,
  - user corrections, splits, and annotations,
  - schema and version information.
- **Backups are encrypted locally** with a user-chosen passphrase. The same holds for decryption. The passphrase is **never** stored in the app, in browser storage, or alongside the backup. A forgotten passphrase means the backup cannot be recovered. The UI says so plainly.
- If encrypted backup cannot be implemented safely, explain the trade-off. Never present a plain file as encrypted.
- **Restore safely:**
  1. Validate a backup (integrity, format, schema version, internal consistency) **before** restoring.
  2. Show what it contains.
  3. Warn clearly before replacing existing data.
  4. Never overwrite existing data by accident.
  5. Restore atomically, or leave the existing data untouched.
- Moving to a new computer or browser means making a backup, then restoring it on the new machine. This path must be practical and tested.
- No automatic cross-device synchronization in version one.

## 9. Household and account model

- One household with multiple accounts. Reports treat all accounts as one joint household.
- Retain account identity internally on every transaction, so transfers and duplicates can be identified reliably.
- Initial account kinds: checking, savings, and credit card.
- Account names and owners are settings.

## 10. Financial definitions

These definitions are the contract for every calculation. Each must be covered by automated tests.

1. **Spending is based on purchases and charges**, not on money moving between accounts.
2. **Credit-card purchases count as spending when charged.**
3. **Credit-card payments are not spending.** This covers a payment from checking and the matching credit on the card. Both are transfers or payments.
4. **Transfers between our own accounts are neither income nor expenses.** This covers checking ↔ savings, checking ↔ checking, and so on.
5. **Moving money into savings is not spending.**
6. **Employment income from both spouses is one category,** Employment Income.
7. **Family gifts are tracked separately** from employment income.
8. **Refunds** reduce their original expense category when the original purchase can be identified. Otherwise, flag them for review. Never automatically inflate ordinary income.
9. **Cash withdrawals** may be classified as *Cash / Untracked Cash Spending*. The user is never required to explain them. Optionally, the user may annotate or reclassify a withdrawal (for example, as a cash gift), or split it across categories. The data model supports splits from the start.
10. **Actual net cash flow = recognized income − recognized expenses**, excluding internal transfers and card payments.
11. **Net cash flow is not the change in a checking-account balance,** and the UI never conflates the two.
12. Transfers stay visible as their own transaction type where useful, but they are excluded from income and expense totals.
13. **Never double-count** transactions that appear in overlapping statements or on both sides of a transfer.
14. **Money is exact.** All arithmetic uses integer cents. Rounding happens only for display.

## 11. Categorization

- **Taxonomy:**
  - Start with a familiar spending taxonomy inspired by common consumer-finance tools, then tailor it to the household's real transactions, inside the app.
  - Use a small number of useful top-level categories. Subcategories are optional and one level deep.
  - **Childcare & School** is a prominent, independent category, never buried in Other.
- **Income is kept separate** from spending. The initial income categories are:
  - Employment Income,
  - Family Gifts,
  - Refunds & Reimbursements,
  - Interest & Investment Income (when present),
  - Other Income.
- **No simplistic rules.** A deposit from a company is not automatically employment income. A person's name or shared surname does not automatically mean a family gift.
- **Evidence** comes from:
  - description,
  - direction,
  - amount,
  - recurrence,
  - dates,
  - account,
  - statement context,
  - prior user corrections.

  Every automatic classification carries a confidence score and plain-language reasons. Uncertain transactions are flagged for review.
- **Learning from corrections:**
  - Corrections create editable merchant and transaction rules.
  - User corrections are **never silently overwritten** by future imports.
  - Users can rename and merge merchants, change categories, and split transactions.
- **Catch-all categories:** Other and Uncategorized remain available. If a large share of spending or income lands there, the app surfaces it as a **categorization-quality problem** to fix, not as an acceptable permanent outcome.
- Categorization is validated against real examples **inside the local app**, never by sending the ledger to an AI service.

## 12. Import quality and auditability

- Every dashboard total must be traceable to its underlying transactions.
- Original statement descriptions are preserved alongside normalized merchant names.
- Statement validation results (date range, counts, balances) are stored with each imported statement and stay visible.

## 13. Dashboard and reporting

- **Answer these easily:**
  - Where does our money go?
  - Where does it come from?
  - Is recognized income greater than expenses?
  - How much did we spend per week, month, year, or custom period?
  - What changed versus the prior period?
  - What are the biggest contributors?
- Incoming money has its own section, separate from the spending category list. Ordinary employment income is shown apart from exceptional inflows (family gifts, one-time refunds), while every correctly classified transaction still counts in net cash flow.
- **Defaults:**
  - a clear summary,
  - simple visualizations,
  - readable rounded numbers,
  - direct drilldown to transactions.
- Custom date ranges and comparisons are available without cluttering the first screen.
- Budgets are deferred and never required.

## 14. Engineering and release expectations

- **Work in phases:**
  1. Foundation and principles.
  2. Data model and tested calculations.
  3. Local PDF parsing and import review.
  4. Persistence and encrypted backups.
  5. Dashboard and drilldowns.
  6. Polish and end-to-end validation.

  Resolve foundational security and data-model questions before large implementations.
- Keep these independently testable:
  - PDF parsers,
  - transaction normalization,
  - categorization,
  - duplicate detection,
  - calculations,
  - storage,
  - backup,
  - UI.
- **Required automated tests include:**
  - transfers and credit-card payments,
  - gifts,
  - refunds,
  - cash withdrawals and splits,
  - duplicate and overlapping imports,
  - malformed, unsupported, and scanned PDFs,
  - missing data,
  - uncertain categories,
  - net cash flow,
  - backup round-trip, wrong passphrase, and tampering,
  - network isolation.
- **Before any commit or push,** run:
  - type checks,
  - unit tests,
  - the repository hygiene check,
  - the production build,
  - the build-output privacy check,
  - the browser network-isolation tests.

  Review the diff for unintended changes and sensitive data. If a check fails or a privacy requirement is unverified, do not describe the work as complete or secure.
- Keep the project easy to extend, but do not over-engineer for hypothetical users.
- **Deploying to GitHub Pages is a release decision.** The app must not be published for use with real data until [§17](#17-open-decisions) items marked *blocking* are resolved. The "Release gate" checklist in `docs/ARCHITECTURE.md` must also pass.

## 15. Current enforcement (what is actually verified today)

| Requirement | Mechanism | Verified by |
|---|---|---|
| No outbound network from the page | CSP `connect-src 'none'`, `default-src 'none'` | `e2e/network-isolation.spec.ts` (asserts a `connect-src` CSP violation) |
| Only same-origin static files load | No CDN, no web fonts, relative asset paths | `e2e/network-isolation.spec.ts`, `scripts/check-build-output.mjs` |
| Shipped CSP is strict | Meta CSP in `index.html` | `scripts/check-build-output.mjs` |
| No console logging, network APIs, `eval`, small-value storage, or URL writes in app code | Source scan | `tests/privacy/source-guards.test.ts` |
| No statements, backups, or exports committed, now or in history | `.gitignore` plus a scan of tracked files and all paths ever added | `scripts/check-repo-hygiene.mjs` (CI) |
| No source maps or data files published | Build config plus output scan | `scripts/check-build-output.mjs` |
| No screenshots, videos, or traces from tests | Playwright config | `playwright.config.ts` |
| Exact money arithmetic | Integer cents | `src/domain/money.test.ts` |
| Financial definitions (§10): card purchases vs. card payments, transfers, savings, combined employment income, gifts, refunds, cash withdrawals and splits, net cash flow ≠ balance change | Pure functions in `src/domain/calculations.ts` | `src/domain/calculations.test.ts` |
| Duplicate and overlap detection: same file, overlapping periods, multiset matching, near-matches flagged, no candidate dropped | `src/domain/dedupe.ts` | `src/domain/dedupe.test.ts` |
| Transfer and card-payment pairing; ambiguity goes to review | `src/domain/transfers.ts` | `src/domain/transfers.test.ts` |
| Refund linking; unmatched or ambiguous refunds are not guessed | `src/domain/refunds.ts` | `src/domain/refunds.test.ts` |

Tests are checked for meaningfulness by deliberately breaking a rule and confirming a test fails. This was done for card-payment exclusion, multiset dedupe, and transfer ambiguity.

Not yet implemented, so **no claims may be made about these yet:** PDF import, IndexedDB persistence, the app lock, encrypted backup and restore, origin isolation in deployment, categorization, and the dashboard over real data. The calculation functions are tested, but no real data flows through them yet.

## 16. Residual risks we accept and document

These remain after our mitigations. The user-facing help must describe them honestly.

1. **Anyone with access to the computer account and browser profile** can open the app and see the data. Once the app lock (D2) is built, this applies only **while the app is unlocked**. Until then, the data is not encrypted by the app. Mitigations: auto-lock, OS login, full-disk encryption, a dedicated browser profile.
2. **Browser extensions** with access to the page can read what it displays and stores. Mitigation: use a browser profile without extensions for this app.
3. **Compromised code delivery.** Someone with push access to the repository could, through a stolen GitHub account or malicious dependency, publish code that reads the data and sends it elsewhere, for example by navigation, which CSP cannot fully block. A malicious deploy could also change the CSP itself. Mitigations:
   - 2FA on the GitHub account,
   - branch protection,
   - pinned, minimal, reviewed dependencies,
   - SHA-pinned Actions,
   - manual deploys.
4. **Shared origin.** Until D1 is resolved, other GitHub Pages projects on the same account share this origin and its storage.
5. **Clickjacking.** GitHub Pages cannot send `X-Frame-Options` or a CSP `frame-ancestors` header, and `frame-ancestors` is ignored in meta tags. The app takes no sensitive one-click actions, and destructive actions require confirmation dialogs.
6. **Data loss.** Browser storage can be cleared. Backups are the only protection, and a forgotten backup passphrase cannot be recovered.
7. **Parser errors.** Extraction can be wrong. Validation against statement totals, review screens, and flags reduce this risk but do not remove it.
8. **Backup files** are only as strong as the passphrase. Where they are stored is the user's choice.

## 17. Open decisions

| ID | Decision | Status | Recommendation |
|---|---|---|---|
| D1 | **Dedicated origin** so no other site shares this app's storage. The household does not currently own a domain. | **Blocking** before real data. Recommendation awaiting approval. | A free GitHub organization used only for this app, with Pages enabled on this repository only. See `docs/ARCHITECTURE.md` §3, plus a runtime origin guard that refuses to open the vault on any other origin. |
| D2 | **App lock / at-rest encryption.** | **Decided 2026-10-19: required.** Design awaiting approval. | Passphrase-unlocked vault: a random data key, wrapped by an Argon2id-derived key, held in memory only while unlocked. Auto-lock on idle. See `docs/ARCHITECTURE.md` §7. |
| D3 | **Key derivation and backup encryption.** | Recommendation awaiting approval. | Argon2id (RFC 9106) via `@noble/hashes` (pure JS, zero dependencies, no CSP change), with AES-256-GCM via WebCrypto. The same scheme is used for the app lock and for backups. See `docs/ARCHITECTURE.md` §8. |
| D5 | **Deployment.** The Pages deploy workflow is manual-only until D1 and the release gate are satisfied. | Open | Keep manual |
| D6 | **Offline use / service worker.** Would improve resilience, but a cached service worker can also persist a bad deploy. | Deferred | Not in v1 |

## Change log

- **2026-10-19, v1.1.**
  - D2 decided by the household user: a passphrase app lock is required, and the encryption key is never persisted alongside the data.
  - D1 direction: no custom domain is available. Investigate a dedicated GitHub organization, with deployment manual-only until isolation is verified.
  - D3 direction: prefer Argon2id when a reputable implementation can be integrated safely. Never implement custom cryptography.
  - Phase 2 calculations implemented and tested (§15).

- **2026-10-18, v1.0.** Created from `household-finance-product-and-security-principles.md` and the project brief. All original requirements incorporated (see the appendix). Added:
  - origin isolation (D1),
  - CSP-based network enforcement,
  - integer-cent arithmetic,
  - last-four-digits-only account identifiers,
  - no stored PDFs,
  - residual-risk register,
  - open-decision register.

---

## Appendix: traceability to the original document

| Original section | Where it lives now |
|---|---|
| 1. Non-negotiable: financial data privacy (all bullets) | §1, §2, §3, §8, §16 |
| 2. Product goal | §4 |
| 3. User experience and visual direction | §5 |
| 4. Initial workflow and data storage | §6, §7, §8 |
| 5. Accounts and household model | §9, §3.1 (no bank credentials), §4 (settings, not hardcoded) |
| 6. Financial definitions and transaction rules | §10 |
| 7. Categorization principles (including the AI/real-statement rule) | §11, §3.4 |
| 8. Import quality and auditability | §7, §12 |
| 9. Dashboard and reporting | §13 |
| 10. Engineering and release expectations | §14, §15 |
