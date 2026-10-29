# Architecture and Implementation Plan

Companion to [`PROJECT_PRINCIPLES.md`](../PROJECT_PRINCIPLES.md). The principles say *what must be true*; this file says *how*. If they disagree, the principles win and this file gets fixed.

**Status (2026-10-29):** Mac app direction approved. The encryption choice (§5) and this plan await review. Nothing in §4–§12 is implemented yet unless marked *done*.

## 1. Shape of the app

```
 ┌──────────────── Household Money.app (macOS App Sandbox, no network entitlement) ────────────────┐
 │                                                                                                 │
 │  App window (Apple WebKit)                       Rust core (small)                              │
 │  ┌───────────────────────────────┐   IPC only    ┌──────────────────────────────────────────┐   │
 │  │ Existing Preact UI            │ ◄───────────► │ unlock / lock / save / load              │   │
 │  │ src/domain (calculations,     │               │ encrypt & decrypt (age)                  │   │
 │  │   dedupe, transfers, refunds) │               │ atomic file writes, one-writer lock      │   │
 │  │ pdf.js (reads chosen PDFs)    │               │ backup create / restore                  │   │
 │  │ CSP: no network               │               └──────────────────┬───────────────────────┘   │
 │  └───────────────────────────────┘                                  │                           │
 └─────────────────────────────────────────────────────────────────────┼───────────────────────────┘
                                                                       ▼
            ~/Library/Containers/<app id>/…/ledger.age (+ previous)     Backups: wherever you save them
```

- The UI and all financial logic stay in TypeScript, unchanged.
- The Rust side does only what a web page cannot do safely: hold the passphrase in memory, encrypt, and write files atomically.
- PDFs are read in the window through a normal file picker or drag-and-drop. They never pass through Rust and are never stored.

## 2. Main choices

| Choice | Decision | Why |
|---|---|---|
| Platform | Tauri 2, macOS only | Uses the Mac's own WebKit, which macOS keeps patched. The app is small and the native code is minimal. |
| UI | Existing Preact + Vite build | Reuse what exists; it already ships no network code and a strict CSP |
| Logic | Existing `src/domain` (TypeScript) | Already tested; runs unchanged in the app window |
| Storage | One encrypted file, plus the previous version | Simple and atomic, and Time Machine backs it up (encrypted) |
| Encryption | `age` format via its Rust crate (recommended, §5) | No custom cryptography; backups recoverable with an independent tool |
| Updates | Manual: install a newer build | No network code at all |
| Getting it onto the Mac | Built in GitHub Actions on macOS; download and open (§12) | No paid signing; no toolchain needed on your Mac |

**Retired:** GitHub Pages hosting and its deploy workflow, the dedicated-origin plan (D1), IndexedDB, and the earlier browser-side Argon2 (`@noble/hashes`) recommendation. The Pages deploy workflow will be deleted in Phase A.

## 3. What is reused

- **Unchanged:**
  - `src/domain/*` and its 92 unit tests;
  - the Preact UI and styles;
  - `index.html` with its CSP;
  - the source guard, build-output and repo-hygiene checks;
  - the Playwright network tests, which keep testing the UI build.
- **Added:**
  - `src-tauri/` (Rust core, config, entitlements);
  - a small `src/storage/` interface in TypeScript that calls the Rust commands, with an in-memory version for tests;
  - macOS jobs in CI.

## 4. Permissions (least privilege)

**macOS App Sandbox entitlements:**
- `com.apple.security.app-sandbox` = true.
- `com.apple.security.files.user-selected.read-write` = true: the app can touch only files you pick (PDFs, backup locations) plus its own container.
- **No** `network.client` or `network.server` entitlement. macOS itself denies the app network access.
- No camera, microphone, contacts, location, or automation.

**Tauri:**
- **Capabilities:** only the app's own commands (`unlock`, `lock`, `load`, `save`, `backup_create`, `backup_read`, `restore_commit`, `status`) plus the dialog plugin's open and save dialogs, which pick the backup file location.
- **No other plugins:** no `fs`, `http`, `shell`, `opener`, `updater`, or `process`.
- **CSP:** the existing policy, with `connect-src` limited to Tauri's own IPC channel (`ipc: http://ipc.localhost`); everything else stays `'none'`.
- **Navigation:** navigation away from the app's bundled pages and new windows are refused in Rust. This closes the browser-era gap where a page could navigate away with data in the URL.
- **Single window,** with developer tools disabled in release builds.

*To verify in Phase A:* that Tauri's window works under App Sandbox with an ad-hoc signature (no paid certificate), and exactly which CSP entries Tauri's IPC needs. If the sandbox cannot be made to work, I will stop and report back rather than quietly dropping it.

## 5. Encryption (D3): options and recommendation

**What we need:**
- encrypt one data file and backup files with a passphrase;
- a memory-hard key derivation, to slow offline guessing;
- authenticated encryption, so tampering and truncation are detected;
- **no cryptography designed by us**;
- maintained code;
- backups we can recover even if the app breaks.

| Option | What *we* would design | Assurance (stated honestly) | Dependency weight | Recover a backup without the app |
|---|---|---|---|---|
| **`age` 0.12.1 (Rust)**, standard age-v1 format: scrypt + ChaCha20-Poly1305, chunked | **Nothing.** We call encrypt or decrypt on a whole file. | Format by Filippo Valsorda and Ben Cox with a public spec and an independent Go reference implementation. The cipher crate it uses (`chacha20poly1305`) had one NCC Group audit. **I found no independent audit of the `age` crate itself or of `scrypt`.** Released July 2026. | Heavier: about 24 direct crates, including unused post-quantum and translation crates. Pre-1.0 version number. | **Yes:** the `age` command-line tool (`brew install age`) |
| RustCrypto `argon2` + `chacha20poly1305` / `aes-gcm` | Our own file format: headers, nonces, key handling | Ciphers NCC-audited once; `argon2` makes no audit claim | Small | Only with our documented recipe |
| Apple WebCrypto in the window (AES-GCM + PBKDF2) | Our own format, in JavaScript | Apple's built-in cryptography; very mature. PBKDF2 is **not** memory-hard. | None | Recipe only |
| `@noble/hashes` Argon2id + WebCrypto (previous plan) | Our own format | The library is audited, but its **Argon2 module is outside that audit** | 1 | Recipe only |
| libsodium (C, via `libsodium-sys-stable`) | Our own format | Long, strong track record | C library to build | Recipe only |

**Recommendation: `age`.**
- In small projects the realistic danger is mistakes in *combining* primitives, such as nonce handling, header binding, and truncation. `age` removes that whole class: we write no cryptographic construction.
- Its passphrase mode is memory-hard (scrypt, which targets about 1 second of work).
- Every backup can be opened with a well-known independent tool, which is the strongest recovery story available.

**Trade-offs and mitigations:**
- **No confirmed audit of the `age` crate.** The format and the Go implementation are widely used and reviewed by the community, but that is not an audit. Interoperability tests (§11) show the formats match; they do not prove security.
- **Larger dependency tree.** Mitigations: pin the exact version, run RustSec advisory checks in CI, record it in §13, and enable no optional features.

If you prefer the smallest dependency set, the RustCrypto option is the alternative, but then we would own a file format.

**How it is used:**
- **Data file:** `ledger.age` holds the whole ledger as JSON, encrypted with the household passphrase.
  - Unlocking decrypts it, which takes about 1 second.
  - The passphrase is then held only in Rust memory (zeroized on lock) so saves can re-encrypt. Saves run in the background, and rapid edits are combined into one save.
  - Nothing key-related is ever written to disk.
- **Locking:** a Lock button, after 15 minutes of inactivity (adjustable), and on quit. Locking wipes the passphrase in Rust and reloads the window, which discards all decrypted data from the page.
- **Changing the passphrase:** the ledger is re-encrypted with the new passphrase.
- **Passphrase guidance:** at least 12 characters. The app can suggest one made of random words. It is honest that a forgotten passphrase cannot be recovered.

## 6. Saving safely and handling errors

**Save sequence:**
1. Validate the ledger in TypeScript (schema version, references, split sums).
2. Encrypt to `ledger.age.tmp` and flush it to disk.
3. Move the current file to `ledger.previous.age`.
4. Rename the temporary file to `ledger.age`, an atomic operation on APFS.
5. Flush the folder.

At every step either the new or the previous complete file exists.

**Loading:**
1. Try `ledger.age`.
2. If it is missing, truncated or corrupt, offer `ledger.previous.age` and explain what happened.
3. If a data file exists but cannot be opened, **never** start a fresh empty ledger over it.

**One writer:** an exclusive file lock. A second copy of the app shows "Household Money is already open".

**Errors:**
- Rust returns fixed error codes such as `wrong_passphrase`, `file_corrupt`, `disk_full`, `newer_version` and `already_open`. The UI maps each to a friendly message and a safe next step.
- No error text contains data, and nothing is logged.
- After a failed save, the in-memory data is kept and the save can be retried.

**Import commit:** one save. A cancelled or failed import changes nothing.

## 7. Backup and restore

- **Make a backup:**
  1. Choose a location (for example a USB drive).
  2. Type a backup passphrase twice. It may be the same as the household passphrase.
  3. The app encrypts (age passphrase mode) and writes the file atomically.
  4. **It reads the file back and decrypts it to check it,** then records "last backed up".
- **Restore:**
  1. Pick the file and enter its passphrase.
  2. The app decrypts it in memory and validates the schema version and internal consistency.
  3. It shows a summary: date range, accounts, transaction count.
  4. You confirm.
  5. The current data is kept as `ledger.before-restore-<date>.age`, still encrypted.
  6. The restored data is saved with the normal atomic save.
  7. Any failure leaves current data untouched.
- **Without the app:** `age -d household-backup.age > backup.json` decrypts a backup. This is documented and tested.
- **New Mac:** install the app, then restore a backup.
- Time Machine also copies the encrypted data file. That is a bonus, not the backup plan.

## 8. Data model (schema v1)

The types live in `src/domain/types.ts` and the taxonomy in `src/domain/categories.ts`. Both are unchanged.

- **Main records:**
  - accounts (with only the last four digits);
  - statements (period, balances, PDF SHA-256, validation results);
  - transactions (signed integer cents, an immutable original description, an editable merchant, kind, classification with confidence and reasons, optional splits, transfer and refund links);
  - categories;
  - rules;
  - settings.
- **Sign convention:** negative means money out or debt up; positive means money in or debt down.
- **Recognition rules** are implemented in `src/domain/calculations.ts` (*done*).
- The saved file wraps these records with a schema version. Migrations are pure TypeScript functions, each with a test.

## 9. Import pipeline

1. **Read** each chosen PDF in the window, compute its SHA-256, and extract positioned text with pdf.js. Run it in a worker, with font loading, eval and network disabled.
2. **Classify** each file as text-based or image-only (scanned). Image-only files are flagged as unsupported.
3. **Pick a parser.** Each registered parser scores how well it recognises the document; the most confident one parses it. If none is confident, the file is flagged as an unsupported layout.
4. **Validate:** balances, totals, counts, dates inside the statement period, and every amount parses (amount parsing never guesses).
5. **Deduplicate** against saved data: same file, overlapping periods, multiset matching, near-matches flagged (`src/domain/dedupe.ts`, *done*).
6. **Classify** transactions and link transfers and refunds (*done*: `transfers.ts`, `refunds.ts`). Anything uncertain is flagged.
7. **Review screen.** Confirm, or discard.
8. **Commit** as one save.

## 10. Refining parsers without sharing statements

- Parsers are developed against **synthetic PDFs** generated by test scripts. They mimic each layout's structure using invented data.
- When a real statement doesn't parse correctly, an in-app diagnostics panel shows **masked structure** on screen only:
  - which parser was tried and why,
  - which check failed,
  - line shapes like `DATE TEXT AMOUNT`, with values hidden.

  You describe or copy that masked shape, and a matching synthetic fixture is written from it. No real document leaves the Mac.

## 11. Verification and tests

**Network isolation:**

| Layer | How it is checked | Where |
|---|---|---|
| UI code makes no requests; CSP blocks them | Existing Playwright tests, run on Chromium **and WebKit** (WebKit is the engine the Mac app uses) | CI |
| No networking code ships | Script fails if `Cargo.lock` contains HTTP or socket client crates (`reqwest`, `ureq`, `hyper` client, `isahc`, `curl`, `attohttpc`, `tungstenite`) | CI |
| Permissions are as listed in §4 | Script checks the Tauri config (CSP, capabilities, plugin list, devtools off) and the entitlements file (sandbox on, no network keys) | CI |
| The built app really has those entitlements | `codesign -d --entitlements` on the built `.app` | macOS CI |
| The running app opens no network connections | Launch the built app and confirm with `lsof -i` that neither it nor its WebKit processes hold any sockets | macOS CI |
| Real-world check | On your Mac, run the free LuLu firewall set to block everything (or turn Wi-Fi off), use the app end to end, and confirm zero connection attempts | Manual, before go-live |

**Storage, encryption and interruptions** (Rust `cargo test`, plus TypeScript tests):
- **Encryption:**
  - round-trip;
  - wrong passphrase;
  - tampered, truncated or swapped files are detected;
  - a file newer than the app's schema version is refused.
- **Interrupted saves:** a crash simulated at each step of the save sequence leaves a loadable file. The previous-version fallback works. A file that cannot be opened is never overwritten with an empty ledger.
- **Errors and concurrency:**
  - a second app copy is refused;
  - a disk write failure leaves data intact and can be retried.
- **Backup and restore:**
  - backup round-trip and the read-back check;
  - restore validation failures change nothing;
  - an interrupted restore leaves current data intact;
  - the pre-restore copy is created.
- **Interoperability:** in CI, files made by the app are decrypted with the Go `age` tool, and files made by `age` are decrypted by the app. This shows format compatibility; it is not an audit.
- **Lock and unlock:** the lock clears state, idle auto-lock fires, and saves are refused while locked.
- **Migration:** schema migrations, each with a test.

**Import** (Phase D): malformed, encrypted, scanned and unsupported PDFs; ambiguous and missing values; duplicate and overlapping imports; review-before-save; cancelling mid-import.

All tests use synthetic data. Real data is never used in CI.

## 12. Phased plan

Each phase is small, tested, pushed, and reviewed by you before the next starts.

| Phase | Scope | Done when |
|---|---|---|
| **A. Mac shell** | Wrap the existing UI in Tauri; App Sandbox without network entitlements; CSP, capabilities and navigation lock; config and crate checks; macOS CI build with entitlement and socket checks; delete the Pages deploy workflow | The app opens on your Mac showing today's welcome screen, and every network check passes |
| **B. Encrypted storage** | Passphrase setup and unlock screen, lock and auto-lock, atomic save and load, previous-version fallback, single-writer lock, error messages | Storage, interruption and lock tests pass |
| **C. Backup and restore** | Make, check, restore and pre-restore copy; `age` interoperability tests | Backup tests pass, and a restore rehearsal works on your Mac |
| **D. PDF import** | pdf.js, parser interface, synthetic layouts, scanned-PDF detection, review screen, diagnostics | Import tests pass |
| **E. Dashboard** | Overview, spending and income, comparisons, drilldowns, review queue, rules from corrections | Totals traceable; tests pass |
| **F. Go-live** | Checklist in §14 | You import real statements, on your Mac only |

**Getting the app onto your Mac** (no paid signing):
- The repo is public, so I expect GitHub's macOS runners to be free. That is from my own knowledge and has not been checked from here.
- CI builds an ad-hoc-signed `.app`, zipped, and prints its SHA-256. The artifact is kept for 7 days and contains only code.
- **Install steps:**
  1. Download the zip.
  2. Check the checksum.
  3. Move the app to Applications.
  4. On first launch, allow it once in **System Settings → Privacy & Security → Open Anyway**.
- **Alternative:** build it on the Mac itself with `npm run app:build`. This needs Xcode Command Line Tools and Rust, but avoids the warning.

## 13. Dependency register

| Package | Runtime? | Touches financial data or keys? | Network | Assurance and notes |
|---|---|---|---|---|
| preact 10.29.8 | Yes | Renders it | None | Zero dependencies |
| tauri 2.x (planned, Phase A) | Yes | Carries IPC | None used; no network plugins | Version pinned in `Cargo.lock` |
| tauri-plugin-dialog (planned, A) | Yes | Returns file paths only | None | Open and save dialogs only |
| age 0.12.1 (planned, B; pending D3 approval) | Yes | Encrypts and decrypts everything | None | Format spec plus Go reference implementation; its cipher crate is NCC-audited; **no audit found for the crate itself** |
| pdfjs-dist (planned, D) | Yes | Reads statements | Disabled; blocked by CSP and sandbox | Reviewed in Phase D |
| vite, vitest, typescript, @playwright/test, @types/node, @tauri-apps/cli | Dev only | Synthetic data only | Not shipped | — |

## 14. Household go-live checklist (before real statements)

- [ ] Phases A–E are complete, and `npm run verify` plus the Rust and macOS checks pass on the build you install.
- [ ] The built app's entitlements were shown to have the sandbox on and no network access.
- [ ] The LuLu or Wi-Fi-off test showed no connection attempts during setup, import, backup and restore with synthetic PDFs.
- [ ] The household passphrase is chosen and stored safely (for example written down at home, or in a password manager).
- [ ] A backup was made, opened with `age -d`, and restored in a test, confirming recovery works.
- [ ] The checksum of the installed build matches the CI output.
- [ ] GitHub 2FA is on.
