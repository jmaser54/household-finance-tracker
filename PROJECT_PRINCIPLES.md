# Project Principles — Household Finance Tracker

**Status:** Canonical, living source of truth for product, privacy, security, and financial-correctness requirements.
**Supersedes:** `docs/reference/household-finance-product-and-security-principles.md`, kept for history only. Do not edit it or develop against it.
**Last reviewed:** 2026-10-30 (v2.6: statement import on Monterey's built-in WebKit)

## How to use this document

- Read the relevant sections **before** implementing anything that touches privacy, storage, security, imports, backups, or financial calculations.
- When requirements change, change them **here** and record the change in the [change log](#change-log). There is exactly one principles document.
- **Precedence:**
  1. §1 privacy overrides everything.
  2. Financial correctness (§10–§12).
  3. Dependability (§8).
  4. Approachability (§5).
  5. Feature count comes last.
- "Must" and "never" are non-negotiable. Weakening one requires the household user's explicit approval, recorded in the change log.
- If a requirement cannot be met or verified, stop and say so. Do not ship a weaker version that looks like it meets the requirement.

---

## 1. Rule number one: financial data is accessible only to the household user

> **Financial data must be accessible only to the household user.** Never expose financial statements, transactions, account information, or derived financial data (balances, categories, summaries, merchant history) to other users or unauthorized parties.
>
> **If we cannot implement a reasonable, defensible security architecture, do not ship the application.**

This applies to everything the project produces: the running app, its data files, backups, the source repository, CI, logs, test fixtures, screenshots, and conversations with AI coding tools. Each installation holds only its own household's data. Nothing is shared between installations.

## 2. Honesty about security

- Our job is to **minimize** risk and **document what remains**. No application can promise zero risk, and we never claim one.
- **Only make verified claims.** A claim must be true of the implementation **and verified**, for example by a test, an inspected configuration, or a firewall log.
  - Acceptable: "This app contains no networking code, its window cannot send requests or leave the app, and statements are read on this Mac."
  - Not acceptable: "macOS blocks this app from the internet". It does not: see §3.1.
  - Not acceptable: "bank-level security", "100% secure", "unhackable".
- **A passing test is not a security audit.** That includes test vectors and interoperability tests. Say which assurance a component actually has.
- Never call data or a backup encrypted unless encryption is implemented, applied to that file, and tested, including wrong-passphrase and tamper tests.
- Residual risks are listed in [§16](#16-residual-risks) and must be kept current.

## 3. Privacy and security requirements

### 3.1 Architecture boundary

- **A standalone macOS desktop app** (Tauri). Statements are read, and all records, calculations and results are produced and stored, **on the household's Mac**.
- **No network requests during normal use.**
  - No bank connections, no aggregators.
  - No accounts or logins.
  - No cloud storage or sync.
  - No backend.
  - No external APIs, including AI APIs and external OCR.
  - No analytics, telemetry, crash or error reporting.
  - No remote fonts, scripts, or update checks.
- Adding any network capability requires the household user's explicit approval, recorded in the change log. This includes auto-updates.
- **Least privilege.** The app has only the permissions it needs:
  - the macOS App Sandbox, with **outgoing network connections permitted** (`network.client`) because Apple's WebKit will not display the app's own pages in a sandboxed app without it. No incoming connections (`network.server`), and no hardware or personal-data access;
  - access only to the app's own data folder, plus a file the user picks in a save or open panel (backups);
  - a minimal Tauri capability list.

  See `docs/ARCHITECTURE.md` §4.
- **No OS-level network block.** macOS **permits** this app to make outgoing connections. The app is designed and checked not to use that permission; it is not prevented from doing so by the operating system. Never describe it as OS-enforced network blocking.
- **Enforced in the app and verified, not just intended.** The no-network rule rests on these layers:
  - no networking code: no network crates, Tauri plugins or app commands;
  - a Content-Security-Policy in the app window that forbids all requests;
  - navigation refused for anything outside the app's bundled pages.

  Each layer is checked automatically, including inside the packaged app on macOS. The running app is also checked for open network connections (`docs/ARCHITECTURE.md` §11). These checks reduce the risk; they cannot prove that no build could ever connect (§16).
- Bank login credentials are never requested or stored.

### 3.2 Data handling inside the app

- **Never** put financial data in:
  - error messages,
  - console output,
  - log files,
  - window titles,
  - file names chosen by the app,
  - URLs,
  - crash reports.

  The app has no logging or reporting pipeline. Errors are shown on screen as plain-language messages that contain no data.
- Only the **last four digits** of an account number may be stored, and only to match statements to accounts.
- Original PDFs are **not** stored. Only a SHA-256 fingerprint is kept, to detect repeat imports.
- Decrypted data exists only in the app's memory while it is unlocked.

### 3.3 Dependencies and supply chain

- Minimize dependencies. Nothing is loaded from the internet at runtime: everything ships inside the app.
- Every dependency that can read statements, transactions or keys (PDF parser, encryption library) is reviewed and recorded in `docs/ARCHITECTURE.md` §13. The record covers its purpose, version, and assurance level.
- Pin exact versions. Use `package-lock.json` and `npm ci` with install scripts disabled, and commit `Cargo.lock`. Check Rust crates against the RustSec advisory database in CI. Pin GitHub Actions to commit SHAs.
- Prefer mature releases for anything that touches data.

### 3.4 Source control, CI, and AI tooling

- **Never** put any of the following into GitHub, source control, Git history, CI logs, test fixtures, screenshots, build artifacts, or uploaded artifacts:
  - statements (including redacted ones),
  - transactions,
  - merchant histories,
  - account numbers,
  - data files or backups,
  - passphrases or other secrets,
  - any private household information.
- Only **synthetic** fixtures generated by scripts in this repository may be used for development, tests, and CI.
- **Real statements are opened only in the finished app on the household's Mac.**
  - AI coding assistants (including Claude Code) must never request, upload, inspect, or receive real statements, transactions, data files, or backups.
  - The app must never depend on sending documents to any external service.
- Parser accuracy against real formats is checked locally by the household user, with in-app diagnostics that show only masked structure (`docs/ARCHITECTURE.md` §10).
- CI uploads only the built app (code, no data). It never uploads screenshots, videos, or traces.
- **Git history is permanent.** Deleting a file later does not remove it from history, forks, or clones. The hygiene check scans every path ever added. If private data were ever committed, treat it as exposed.

## 4. Product goal and scope

A household **spending and income tracker** for a married couple with separate accounts and fully joint finances. **Current focus: this household, on one Mac.** The app supports **macOS 12 Monterey or later, on Intel and Apple Silicon Macs** (one universal app), because the household's Mac is a 2017 Intel MacBook Air on Monterey.

- **Not now:**
  - Windows or Linux builds,
  - public distribution or a download website,
  - paid code signing,
  - auto-updates,
  - multi-user accounts,
  - sync.
- Keep the code adaptable: account names, owners and categories are **settings**, never hardcoded personal details.
- **Not in scope:**
  - investments,
  - bill payment,
  - bank linking,
  - debt-payoff planning,
  - mandatory budgets.

  Monthly budgets may be considered later. They must never be required.
- **PDF statements only** in the first version.
- Avoid overengineering. The goal is a simple, dependable local program.

## 5. User experience and visual direction

- Optimize for clarity, confidence, and approachability over feature count.
- **Tone:** warm, friendly, patient, and lightly playful, inspired by the welcoming, cartoonish feel of early-1990s *Backyard Baseball*.
  - Do not copy the game.
  - Never make it childish, patronizing, cluttered, or gimmicky.
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
- **First screen after unlocking:**
  - a clear area for adding statement PDFs,
  - a small preview of the dashboard built from fictional data, clearly labelled as illustrative,
  - minimal text.

  No marketing pages, product tour, or lengthy onboarding.
- After confirming an import, go **directly to the updated dashboard**.
- Use progressive disclosure: a simple overview first, with deeper detail through simple drilldowns.
- **Always make these obvious:**
  - what has been imported,
  - what needs review,
  - whether an import or save succeeded,
  - when data was last backed up.
- Backup reminders should be useful but unobtrusive.
- Summary figures are rounded to whole dollars. Exact cents appear in transaction lists and review screens.

## 6. Setup and ongoing imports

- **Initial setup:** about six months of historical statements. For this household that means five accounts (Julia's checking, Julia's credit card, Jeff's checking, Jeff's savings, Jeff's credit card), or about 30 PDFs. These are user-entered settings, not hardcoded values.
- **Ongoing:** add the previous month's statements. Several months can be added at once if some were missed.
- **Every import must:**
  - preserve existing history, user corrections, and rules,
  - detect overlapping statement periods,
  - never create duplicate transactions.

## 7. Statement import and PDF parsing

- PDFs are parsed **inside the app only**. They are never sent anywhere for extraction or OCR.
- Detect text-based PDFs. Identify scanned or image-only PDFs and explain clearly that they are not supported yet. Never guess or claim success.
- Use **modular parsers** per statement layout, behind a common interface. Never hardcode one bank's format throughout the app.
- **Extract, where available:**
  - transaction and posted dates,
  - descriptions,
  - amounts,
  - transaction types,
  - last four digits of the account,
  - statement period,
  - balances or summary totals.
- **Preserve the original description** exactly as printed, alongside the normalized merchant name.
- Validate counts, totals and balances when the statement provides them, and show the result.
- Flag uncertain extraction, unsupported layouts, unreadable PDFs, and missing data.
- **Never silently omit transactions or invent data.** Ambiguous or missing values are flagged, not guessed.
- **Always show a review screen before saving.** Importing is separate from confirming and saving. A failed or cancelled import must not change saved data. Confirmation is saved atomically.
- Detect duplicates, overlapping periods, and the same PDF imported again.
- Keep imports reversible where practical.

## 8. Storage, saving, backup, and recovery

- **Encrypted at rest.** The household's data is stored on the Mac in the app's data folder, encrypted with a key protected by the **household passphrase**.
  - The passphrase and any key derived from it are **never** stored. They exist only in memory while the app is unlocked.
  - The app locks on request, after inactivity, and on quit.
- **Save safely.** Every save is atomic: either the new data is fully written or the previous data remains intact. The previous good version is kept.
  - Interrupted saves (crash, power loss, full disk) must never corrupt or lose saved data.
  - If saved data cannot be read, the app says so plainly and **never** silently starts over with empty data.
  - Only one copy of the app may write the data at a time.
- **Detect and handle errors.** Every failure is shown in plain language with a safe next step, and no data is lost.
- **Backups must:**
  - be **encrypted before they leave the app**, with the household passphrase (decided 2026-10-29: restoring requires the household passphrase that was in use when the backup was made);
  - be saved where the user chooses;
  - include the complete dataset:
    - accounts,
    - settings,
    - categories,
    - rules,
    - corrections,
    - splits,
    - notes,
    - schema version.

  The app has no code path that writes an unencrypted export.
- **Backups are straightforward to make and restore.**
  - Restoring validates the backup before replacing anything (integrity, format, schema version, internal consistency).
  - It shows what the backup contains, and requires confirmation.
  - It keeps an encrypted copy of the data it replaces.
  - It completes fully or leaves current data untouched.
- **Recovery limits are stated plainly.** A forgotten passphrase makes that data or backup permanently unreadable, with no reset and no back door. Backups are the protection against losing the Mac, the data folder, or the passphrase.
- Moving to a new Mac means installing the app and restoring a backup. This path is tested.
- No automatic sync.

## 9. Household and account model

- One household with multiple accounts. Reports treat all accounts as one joint household.
- Every transaction keeps its account identity, so transfers and duplicates can be identified.
- Account kinds: checking, savings, and credit card. Names and owners are settings.

## 10. Financial definitions

These are the contract for every calculation. Each is covered by automated tests (§15).

1. **Spending is based on purchases and charges**, not on money moving between accounts.
2. **Credit-card purchases count as spending when charged.**
3. **Credit-card payments are not spending.** This covers the payment from checking and the matching credit on the card.
4. **Transfers between our own accounts** are neither income nor expenses.
5. **Moving money into savings** is not spending.
6. **Employment income from both spouses** is one category: Employment Income.
7. **Family gifts** are tracked separately from employment income.
8. **Refunds** reduce their original expense category when the original purchase can be identified. Otherwise they are flagged for review. They never automatically inflate ordinary income.
9. **Cash withdrawals** may be classified as *Cash / Untracked Cash Spending* without explanation. The user can optionally annotate a withdrawal, reclassify it, or split it across categories.
10. **Actual net cash flow = recognized income − recognized expenses**, excluding transfers and card payments.
11. **Net cash flow is not the change in a checking balance,** and the UI never conflates the two.
12. Transfers stay visible as their own type but are excluded from income and expense totals.
13. **Never double-count** transactions from overlapping statements or from both sides of a transfer.
14. **Money is exact:** integer cents, with rounding only for display.

## 11. Categorization

- Use a familiar taxonomy with a small number of top-level categories and optional one-level subcategories. **Childcare & School** is a prominent, independent category.
- Income is separate from spending. The income categories are:
  - Employment Income,
  - Family Gifts,
  - Refunds & Reimbursements,
  - Interest & Investment Income,
  - Other Income.
- **No simplistic rules.** A company deposit is not automatically employment income, and a person's name is not automatically a family gift.
- **Evidence** comes from:
  - description,
  - direction,
  - amount,
  - recurrence,
  - dates,
  - account,
  - statement context,
  - prior corrections.

  Every automatic classification carries a confidence score and plain-language reasons, and uncertain ones are flagged.
- **Corrections** become editable rules and are **never silently overwritten** by later imports. Users can rename and merge merchants, change categories, and split transactions.
- **Catch-all categories:** Other and Uncategorized remain available. A large share landing there is surfaced as a quality problem to fix.
- Categorization is tuned against real examples **inside the app on the Mac**, never by sending data to an AI service.

## 12. Import quality and auditability

- Every dashboard total is traceable to its transactions.
- Original descriptions are preserved alongside normalized merchants.
- Statement validation results stay stored and visible.

## 13. Dashboard and reporting

- **Answer these easily:**
  - Where does our money go?
  - Where does it come from?
  - Is income greater than spending?
  - How much did we spend per week, month, year, or custom period?
  - What changed versus the prior period?
  - What are the biggest contributors?
- Incoming money has its own section. Employment income is shown apart from exceptional inflows (gifts, one-time refunds), and all of them still count in net cash flow.
- **Defaults:**
  - a clear summary,
  - simple visualizations,
  - rounded numbers,
  - direct drilldown to transactions.
- Custom ranges and comparisons are available without cluttering the first screen.
- No required budgets.

## 14. Engineering expectations

- Work in **small phases with tests** (`docs/ARCHITECTURE.md` §12). Each phase is reviewed before the next begins.
- Keep these independently testable:
  - parsers,
  - normalization,
  - categorization,
  - duplicate detection,
  - calculations,
  - storage,
  - backup,
  - UI.
- **Required tests include:**
  - financial definitions (§10),
  - duplicate and overlapping imports,
  - malformed, unsupported, and scanned PDFs,
  - missing or ambiguous values,
  - review-before-save,
  - encryption round-trip, wrong passphrase, and tampering,
  - lock and unlock,
  - interrupted saves and restores,
  - backup and restore,
  - network isolation of the built app.
- **Before any commit or push,** run `npm run verify` (and, once the desktop shell exists, the Rust tests and config checks). Review the diff for unintended changes and sensitive data. If a check fails or a privacy requirement is unverified, do not describe the work as complete or secure.
- **Real data starts only after** the household go-live checklist in `docs/ARCHITECTURE.md` §14 passes.

## 15. Current enforcement (what is actually verified today)

| Requirement | Mechanism | Verified by |
|---|---|---|
| UI makes no outbound requests | CSP `connect-src 'none'`, `default-src 'none'` | `e2e/network-isolation.spec.ts` (asserts a `connect-src` CSP violation), Chromium |
| UI loads only its own files | No CDN, no web fonts | `e2e/network-isolation.spec.ts`, `scripts/check-build-output.mjs` |
| Built UI has a strict CSP, no source maps, no data files | Build config | `scripts/check-build-output.mjs` |
| No console logging, network APIs, `eval`, small-value storage, or URL writes in app code | Source scan | `tests/privacy/source-guards.test.ts` |
| No statements, backups or exports committed, now or in history | `.gitignore` plus a scan of all paths ever added | `scripts/check-repo-hygiene.mjs` (CI, full history) |
| No screenshots, videos or traces from tests | Playwright config | `playwright.config.ts` |
| Exact money arithmetic | Integer cents | `src/domain/money.test.ts` |
| Financial definitions (§10) | `src/domain/calculations.ts` | `src/domain/calculations.test.ts` |
| Duplicate and overlap detection | `src/domain/dedupe.ts` | `src/domain/dedupe.test.ts` |
| Transfer and card-payment pairing; ambiguity goes to review | `src/domain/transfers.ts` | `src/domain/transfers.test.ts` |
| Refund linking; nothing guessed | `src/domain/refunds.ts` | `src/domain/refunds.test.ts` |

Tests were mutation-checked: a rule was deliberately broken and a test confirmed to fail. This was done for card-payment exclusion, multiset dedupe, and transfer ambiguity.

**Desktop app (Phase A), verified in macOS CI** (`scripts/macos-smoke-test.sh`, `scripts/macos-verify-app.sh`):
- The packaged, sandboxed app loads and renders its welcome screen.
- Inside the real app window, a request to an outside site is blocked, and navigation to an outside site is refused.
- The release build is ad-hoc signed with exactly two entitlements: App Sandbox and `network.client`. It contains no smoke-test code.
- While running, neither the app nor WebKit's helper processes hold network connections.
- The configuration checks (`scripts/check-desktop-config.mjs`) also run on every push.

**Encrypted storage (Phase B), verified by tests:**
- Rust storage tests (`src-tauri/src/vault.rs`, 22 tests):
  - round trip, with the file on disk shown to be age-encrypted and free of plaintext;
  - wrong passphrase refused;
  - tampered body, tampered header, truncated, garbage and empty files reported as damaged, never as empty data;
  - files demanding excessive work refused;
  - "create" never overwrites existing data;
  - a save interrupted at each of its four steps leaves readable data;
  - torn temporary files ignored;
  - write failures leave data intact;
  - fallback to the previous version, without overwriting it afterwards;
  - only one writer at a time.
- These tests were mutation-checked: skipping the previous-version copy, removing the fallback, and writing directly over `ledger.age` each made tests fail.
- TypeScript tests cover ledger validation (newer versions, bad shapes, broken references, split sums, no data in errors), error-code mapping, and the lock-again-on-invalid-data rule.
- Browser tests cover passphrase setup (too short, mismatch), lock, wrong passphrase and unlock, using the memory-only browser stand-in.
- Inside the packaged, sandboxed Mac app (macOS CI, Intel and Apple Silicon):
  - creating or unlocking the household through the real UI;
  - save, refusal while locked, wrong passphrase refused, unlock intact;
  - the data files are in the sandbox container, age-encrypted, with no plaintext marker.

**Backup and restore (Phase C), verified by tests:**
- Rust tests (`src-tauri/src/vault.rs`):
  - backup round trip, with the file encrypted and free of plaintext;
  - wrong passphrase refused;
  - damaged, truncated, foreign, empty, missing and oversized backups refused;
  - a backup from a faster Mac opens, while one demanding absurd work does not;
  - write failure reported;
  - making a backup never changes household data;
  - restore keeps an encrypted copy of what it replaced, even if that data was unreadable;
  - restore onto a new Mac;
  - a restore interrupted at every step leaves old or restored data, never neither.
- The pre-restore copy and the restore's atomicity were mutation-checked.
- TypeScript and browser tests:
  - the backup date is recorded only when a backup succeeds;
  - wrong-passphrase, damaged, newer-version and cancelled restores replace nothing;
  - a locked household can't be overwritten;
  - two-step restore with a clear confirmation, from the app and from the setup screen.
- Inside the packaged, sandboxed Mac app (macOS CI, with a fixed container file standing in for the panels): backup, wrong passphrase refused, commit without opening refused, restore, and restored data reopening intact. The backup and pre-restore files are age-encrypted with no plaintext.

**Statement import (Phase D), verified by tests on SYNTHETIC PDFs:**
- Reading (`src/import/readStatement.test.ts`), with the real pdf.js legacy build in Node, which lacks `Promise.try` like Safari 17:
  - every row, sign, date and description of the checking, savings and card layouts;
  - two-page tables and continuation lines;
  - New Year date placement;
  - balance validation, including a mismatch;
  - scanned, non-PDF, damaged and no-statement files reported, not guessed;
  - masked diagnostics that contain no values.
- In the app's oldest engine (CI): with the built-ins Monterey's WebKit lacks removed from the page and the worker, statements still import (Chromium); every synthetic statement imports in WebKit 15.4, standing in for Monterey's built-in WebKit, and in WebKit 17.4, with pdf.js running in its own worker. `check:build` fails if any shipped script uses syntax Safari 15 lacks.
- When a file can't be read, "Technical details (no statement contents)" names the step that failed, the error type with digits and quoted text removed, structural facts about the file and the engine's features. A test checks it contains none of the synthetic statements' values.
- Planning and adding (`src/import/plan.test.ts`):
  - transfers and card payments paired, and excluded from totals;
  - cash withdrawals, interest, and pay suggested but flagged;
  - a card refund linked to its purchase and reducing it;
  - identical same-day purchases both kept;
  - the same file again adds nothing;
  - the overlapping day of the next month is recognised;
  - two months at once share one account;
  - rows with unknown signs are never added;
  - corrections are never changed;
  - planning leaves data untouched;
  - the existing calculations give the right totals on imported data.

  Mutation-checked: transfer pairing, period-aware dedupe, and column signs.
- Browser tests (Chromium, and WebKit in macOS CI), recording every request, CSP violation and console message while three statements are read, reviewed and added: **no request beyond the app's own files, no violations, no console output**. Also re-import, overlap, scanned and letter files, balance mismatch held back, rows left out, and cancel.
- Inside the packaged, sandboxed Mac app (macOS CI, Intel and Apple Silicon): a synthetic statement imported through the real UI, then recognised as already added on the next run. The saved data file is encrypted and shows none of the statement's text.

**Not yet implemented, so no claims may be made about these yet:**
- changing the passphrase,
- reopening the pre-restore copy from within the app,
- the real macOS save and open panels (not clickable in CI; first exercised on the household Mac),
- reading the household's real statement layouts (confirmed only by trying them on the household Mac),
- categorization,
- the dashboard over real data.

## 16. Residual risks

These remain after mitigation. The app's help text must describe them honestly.

1. **Anyone using the Mac while the app is unlocked** can see the data. Mitigations: auto-lock, macOS login, FileVault.
2. **Malware or keyloggers on the Mac**, or someone with administrator control of it, can capture the passphrase or read memory. The app cannot defend against a compromised computer.
3. **A malicious build of the app** would receive the passphrase when unlocked. This could come from a compromised GitHub account, a malicious dependency, or a tampered download. Mitigations:
   - 2FA on GitHub,
   - pinned, minimal, reviewed dependencies,
   - CI builds from public source,
   - checksums.
   - Without paid signing, macOS cannot verify the publisher.
4. **Weak passphrases** can be guessed offline from a copied data file or backup. A memory-hard key derivation slows this down but cannot rescue a weak passphrase.
5. **A forgotten passphrase** means permanent loss of that data or backup.
6. **Data loss** from a lost or failed Mac or deleted files. Only backups protect against it.
7. **Parser errors.** Validation and review reduce them but do not eliminate them.
8. **Malicious PDFs** could exploit a bug in the PDF parser. The parser runs inside the app's sandbox, and the window's CSP forbids requests.
9. **Outgoing connections are permitted by macOS.** The sandbox must allow them for WebKit to work. A malicious or buggy build, or exploited code inside the app, would therefore not be stopped by the OS from connecting out. The app's own layers and checks (§3.1) are what stand in the way.
10. **The passphrase passes through the app window.** It is typed into the page and handed to Rust as a JavaScript string, which cannot be wiped, so a copy may remain in WebKit's memory until it is reused. Rust's copy is wiped on lock, and locking reloads the page. Neither removes the risk of memory inspection on a compromised Mac (item 2).
11. **Webview and OS components** (Apple WebKit, macOS) are outside our control. They are patched by macOS updates, so keep macOS up to date.
    - The app uses macOS's built-in WebKit, not the Safari app's. On Monterey it is older than the household's Safari (Safari 15 generation), and Monterey no longer receives macOS updates.
    - Mitigations: the window runs only the app's own bundled code under a strict CSP, PDFs are parsed in the sandboxed app, and nothing remote is loaded. A newer macOS, where the Mac supports it, would remove this risk.

## 17. Decisions

| ID | Decision | Status |
|---|---|---|
| D1 | Dedicated web origin | **Retired 2026-10-29.** Not needed: no web hosting of the app. |
| D2 | Passphrase lock for local data, key never stored | **Decided 2026-10-19.** Design in `docs/ARCHITECTURE.md` §5. |
| D3 | Encryption implementation | **Decided 2026-10-29:** `age` passphrase mode (scrypt + ChaCha20-Poly1305) via its Rust crate, for the data file and backups. No custom cryptography. Verified properties and limitations in `docs/ARCHITECTURE.md` §5. Implemented in Phase B. |
| D4 | PDF library | **Decided 2026-10-29:** pdf.js (`pdfjs-dist` 6.4.299, legacy build, compiled down to Monterey's built-in WebKit), bundled and run in a worker inside the app with eval, font loading and streaming off. See `docs/ARCHITECTURE.md` §9 and §13. |
| D5 | Platform and distribution | **Decided 2026-10-29:** Tauri, macOS only, household use. No paid signing, public distribution or auto-updates for now. |
| D6 | Updates | Manual: install a newer build. Any update check needs approval (§3.1). |

## Change log

- **2026-10-30, v2.6.** Statement import fixed for the household Mac. Security requirements are unchanged.
  - Root cause: the app's window uses Monterey's built-in WebKit (older than Safari 16.4), which can't parse pdf.js 6's class static blocks, so the PDF reader never loaded.
  - All shipped scripts, including the pdf.js worker, are now compiled down to Safari 15, enforced by a build check and by CI imports in WebKit 15.4 and 17.4.
  - Two built-ins pdf.js needs and that engine lacks (`Promise.withResolvers`, `ArrayBuffer.prototype.transferToFixedLength`) are polyfilled, in the page and the worker. A browser test removes them in both and imports statements.
  - Unreadable files now show privacy-safe technical details, and one file's failure no longer marks the rest unreadable.
  - §16 item 11 now records that Monterey's built-in WebKit no longer receives macOS updates.

- **2026-10-29, v2.5.** Phase D: PDF statement import and review.
  - pdf.js (legacy build) runs in the app, with masked diagnostics.
  - A general table reader handles the common checking, savings and card layouts.
  - Review screen with duplicate and overlap detection; balance-mismatched statements are held back.
  - First-pass classification following §10–§11.
  - PDFs are never stored.
  - Real banks' layouts remain to be confirmed on the household Mac.

- **2026-10-29, v2.4.** Phase C: encrypted backup and restore.
  - Backups use the household passphrase and are checked by reading them back.
  - Two-step restore with explicit confirmation; an encrypted copy of the replaced data is kept.
  - Entitlement `files.user-selected.read-write` added (only files picked in a panel).
  - Tauri dialog plugin added, used only from Rust.

- **2026-10-29, v2.3.** Phase B: encrypted local storage.
  - `age` passphrase mode; atomic saves that keep the previous version; fallback on unreadable files; single-writer lock.
  - Passphrase setup, unlock, Lock button and 15-minute auto-lock.
  - Tauri's `freezePrototype` hardening turned off, because it breaks Preact's re-rendering. It guards against untrusted scripts, which the app never loads; the CSP and navigation lock are unchanged.
  - Residual risk 10 added (passphrase in page memory).

- **2026-10-29, v2.2.** Minimum macOS lowered from 13 to 12 Monterey, and the app is built universal (Intel + Apple Silicon) for the household's 2017 Intel MacBook Air. Security requirements are unchanged.

- **2026-10-29, v2.1.** Phase A finding, decided by the household user.
  - Apple's WebKit does not render in a sandboxed app without the outgoing-network entitlement, so the sandbox now grants `network.client`. macOS therefore permits outgoing connections.
  - The no-network rule is upheld by the app's own layers: no networking code, the window CSP, and the navigation lock. Automated checks run inside the packaged app.
  - Wording changed so it never claims OS-enforced network blocking.
  - No separate firewall is required.

- **2026-10-29, v2.0.** Architecture changed to a standalone Mac app (Tauri), approved by the household user.
  - Removed:
    - browser hosting,
    - GitHub Pages deployment,
    - IndexedDB storage,
    - origin isolation (D1 retired).
  - Added:
    - the no-network-during-normal-use rule,
    - least-privilege requirements (App Sandbox without network entitlements),
    - safe-saving and error-handling requirements,
    - "a test vector is not an audit".
  - D3 re-evaluated for the desktop context.
  - All non-negotiable requirements are kept; browser-specific mechanisms were replaced with desktop equivalents.
- **2026-10-19, v1.1.**
  - D2 decided: the passphrase lock is required and the key is never persisted alongside the data.
  - D1 and D3 directions given.
  - Phase 2 calculations implemented and tested.
- **2026-10-18, v1.0.** Created from `household-finance-product-and-security-principles.md` and the project brief.

---

## Appendix: traceability to the original document

| Original section | Where it lives now |
|---|---|
| 1. Non-negotiable: financial data privacy | §1, §2, §3, §8, §16 |
| 2. Product goal | §4 |
| 3. User experience and visual direction | §5 |
| 4. Initial workflow and data storage | §6, §7, §8 (browser storage replaced by encrypted files on the Mac) |
| 5. Accounts and household model | §9, §3.1, §4 |
| 6. Financial definitions and transaction rules | §10 |
| 7. Categorization principles (incl. AI/real-statement rule) | §11, §3.4 |
| 8. Import quality and auditability | §7, §12 |
| 9. Dashboard and reporting | §13 |
| 10. Engineering and release expectations | §14, §15 |

The original's GitHub Pages items ("GitHub Pages hosts code only", browser storage notes) are superseded by the Mac architecture. Their intent, that no financial data is ever stored on or sent to any server, is kept in §3.1.
