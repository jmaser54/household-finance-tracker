# Architecture and Implementation Plan

Companion to [`PROJECT_PRINCIPLES.md`](../PROJECT_PRINCIPLES.md). The principles say *what must be true*; this file says *how*. If they disagree, the principles win and this file gets fixed.

**Status (2026-10-29):** Phases A (Mac app shell), B (encrypted storage, lock and unlock) and C (encrypted backup and restore) are implemented. PDF import and the dashboard are not. Anything not marked *done* is still a plan.

## 1. Shape of the app

```
 ┌─────── Household Money.app (macOS App Sandbox; outgoing connections permitted, not used) ───────┐
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
| Platform | Tauri 2, macOS 12 Monterey or later; one universal app (Intel + Apple Silicon) | Uses the Mac's own WebKit, which macOS keeps patched. The app is small and the native code is minimal. |
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
- `com.apple.security.network.client` = true. **Required:** Apple's WebKit will not display even the app's own bundled page in a sandboxed app without it (Phase A finding below). This means **macOS permits outgoing connections from the app.** The app is built not to make any (no networking code, CSP, navigation lock); the OS does not block them.
- **No** `network.server`: no incoming connections.
- `com.apple.security.files.user-selected.read-write` = true (Phase C): the app may read or write only a file you pick in a save or open panel, which today means backups. Nothing else outside its own container.
- No camera, microphone, contacts, location, or automation.

**Tauri:**
- **Native commands (*done*):** exactly nine: `vault_status`, `vault_create`, `vault_unlock`, `vault_save`, `vault_lock` (Phase B), plus `backup_create`, `restore_open`, `restore_commit` and `restore_cancel` (Phase C), all in `src-tauri/src/commands.rs`. The list is enforced by `check-desktop-config.mjs`. They touch only the encrypted files in the app's own container, and the backup file you pick. No Tauri core or plugin permissions are granted to the window.
- **One plugin: dialog** (Phase C), used only from Rust for the backup save and open panels. It isn't reachable from the window. It pulls in `tauri-plugin-fs` as a library, which is never registered; this is checked. No `fs`, `http`, `shell`, `opener`, `updater` or `process` plugins.
- **CSP:** unchanged and identical to `index.html`, with `connect-src 'none'` still in place. Tauri's IPC therefore uses its built-in fallback message channel instead of its `ipc://` fetch channel; verified working inside the sandboxed app in Phase B. No IPC exception was added to the policy.
- **`freezePrototype` is off.** Preact copies its virtual-DOM nodes when re-rendering, and with `Object.prototype` frozen that copy throws, so the screen could never update (found in Phase B). The option defends against untrusted scripts, which this app never loads. The CSP and the navigation lock remain the boundary.
- **Navigation:** navigation away from the app's bundled pages and new windows are refused in Rust. This closes the browser-era gap where a page could navigate away with data in the URL.
- **Single window,** with developer tools disabled in release builds.

*To verify in Phase A:* that Tauri's window works under App Sandbox with an ad-hoc signature (no paid certificate), and exactly which CSP entries Tauri's IPC needs. If the sandbox cannot be made to work, I will stop and report back rather than quietly dropping it.

**Phase A finding (2026-10-29, macOS 15 CI runner, WebKit 20621):** under the App Sandbox **without** `com.apple.security.network.client`, Apple's WebKit never starts loading the app's own bundled page. The window opens but stays empty. The same build loads normally with no sandbox, and also with sandbox plus `network.client`.

This was shown by re-signing copies of one CI-only smoke build with each entitlement set; the one-off diagnostic script has since been removed. So "sandbox with no network entitlement" is not achievable with a WebKit window. Decided by the household user: keep the sandbox and add `network.client` only.

**Second Phase A finding:** WebKit can report "page loaded" before the app's script has drawn the screen. The in-window smoke check therefore waits up to 10 seconds for the welcome screen before judging it.

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

**Decision (2026-10-29): `age` passphrase mode, for both the data file and backups.** This is the simplest suitable approach: one library call to encrypt, one to decrypt, and no keys of our own to manage.

**Verified by reading the `age` 0.12.1 source** (not by running it yet):
- **Key derivation:** passphrase files use scrypt with a random 16-byte salt.
- **Work factor:** calibrated on the device that creates the file, to about 1 second (log₂N measured at encrypt time; default 18 if timing fails).
- **Decryption ceiling:** decryption refuses files that demand more than about 16× that device's own target (`ExcessiveWork`). This guards against malicious files that would take hours.
  - *Consequence:* a backup made on a much faster Mac could be refused on a much slower one.
  - Phase B therefore sets an explicit, documented ceiling for opening backups.
- **One passphrase per file:** a passphrase must be the only recipient of a file. It cannot be combined with keys or with a second passphrase. That is fine for us: one household passphrase for the data file, and one typed passphrase per backup.
- **Passphrase handling:** the library keeps the passphrase in a `SecretString`, which is wiped from memory when dropped.

**Limitations to state plainly:**
- `age` does not hide a file's approximate size.
- `age` has no notion of "who made this file": anyone with the passphrase can create a valid one.
- No independent audit of the crate was found. Interoperability tests in Phase C check format compatibility, not security.

**How it is used (*done*, Phase B; `src-tauri/src/vault.rs`, `src-tauri/src/commands.rs`):**
- **Data file:** `ledger.age` holds the whole ledger as one JSON document, encrypted with the household passphrase.
  - Encrypting and decrypting each take about 1 second (age calibrates scrypt per device).
  - Files live in the app's sandbox container: `~/Library/Containers/io.github.jmaser54.householdmoney/Data/Library/Application Support/io.github.jmaser54.householdmoney/`.
  - Nothing key-related is ever written to disk.
- **Passphrase in memory:** after unlocking, the passphrase is held only in Rust memory, in age's `SecretString`, which is wiped when dropped, so saves can re-encrypt.
- **Locking:** by the Lock button, after 15 minutes without keyboard, mouse or touch activity, and by quitting. Locking drops the passphrase in Rust and reloads the window, which discards the decrypted ledger from the page.
- **Passphrase rule:** at least 12 characters, not all spaces. This is enforced in Rust; the UI checks the same rule for friendlier messages. The setup screen says plainly that a forgotten passphrase cannot be recovered.
- **Not yet built:** changing the passphrase, an adjustable auto-lock time, and a "suggest a passphrase" helper.

## 6. Saving safely and handling errors

**Save sequence (*done*):**
1. Validate the ledger in TypeScript (schema version, unique ids, references, whole cents, split sums). An invalid ledger is never saved.
2. Encrypt and write `ledger.age.tmp`, then flush it to disk (`sync_all`, which Rust implements with `F_FULLFSYNC` on macOS).
3. Keep the previous version: hard-link `ledger.age` to a temporary name, then atomically rename it to `ledger.previous.age`. There is no moment without a complete `ledger.age`.
4. Atomically rename `ledger.age.tmp` to `ledger.age`.
5. Flush the folder.

A crash at any step leaves a readable `ledger.age`, old or new. This is tested by stopping a save at each step.

**Opening (*done*):**
1. Try `ledger.age`.
2. If it can't be read, try `ledger.previous.age`. If that works, the app opens it and says so plainly. The next save then does **not** copy the unreadable file over the good previous version.
3. If data files exist but can't be opened, the app reports it and **never** offers to start a new, empty household over them.
4. If a file decrypts but isn't a valid ledger (for example, a newer schema), the app locks again at once, so nothing can be saved over it.

**One writer (*done*):** an exclusive lock on `household.lock`. A second copy of the app shows "Household Money is already open".

**Errors (*done*):**
- Rust returns fixed codes: `wrong_passphrase`, `data_damaged`, `excessive_work`, `weak_passphrase`, `vault_exists`, `write_failed`, `read_failed`, `too_large`, `invalid_text`, `locked` and `already_open`. Ledger validation adds `newer_version`, `invalid_shape`, `broken_reference` and `not_json`. The UI maps each code to a friendly message.
- Any unknown error becomes a generic message, so error text from elsewhere is never shown.
- A wrong passphrase and a damaged key section of the file cannot be told apart; the message covers both.
- No error text contains data, and nothing is logged.
- After a failed save, the in-memory data is kept and the save can be retried.

**Import commit:** one save. A cancelled or failed import changes nothing.

## 7. Backup and restore (*done*, Phase C)

**What a backup is:** one file, `Household Money Backup YYYY-MM-DD.hmbackup`, saved wherever you choose (for example a USB drive). It holds the whole ledger: accounts, statements, transactions, categories, rules, settings and schema version. It is encrypted with the **household passphrase** in the same standard age format as the data file. There is no separate backup passphrase, and nothing unencrypted is ever written.

**Make a backup** (`backup_create`):
1. The app records the backup time in the ledger.
2. You choose where to save the file in the macOS save panel.
3. The app encrypts the ledger and writes the file.
4. **It reads the file back and decrypts it**; the backup only counts as saved if the result matches exactly.
5. "Last backup" is updated on the welcome screen.

- *Why not write to a temporary file and rename?* The App Sandbox lets the app write only the exact file you picked, not a temporary file next to it. If writing is interrupted, the file at that spot may be incomplete. The read-back check reports this as "couldn't be checked, try again". The household data itself is never touched by making a backup (tested).
- Cancelling the save panel does nothing and records no backup time.

**Restore** (`restore_open`, then `restore_commit`):
1. Enter the household passphrase that was in use when the backup was made, and choose the file in the open panel.
2. The app reads and decrypts it, refusing:
   - wrong passphrases;
   - damaged or truncated files, and files that aren't backups;
   - files over 65 MB;
   - files demanding excessive unlocking work (above scrypt 2^21, about 2 GiB; a fixed ceiling, so a backup from a faster Mac still opens on the 2017 MacBook Air).
3. The window checks the contents with the same ledger validation used for the data file. A backup from a newer app version, or with damaged or inconsistent contents, is refused and forgotten.
4. You see a summary (accounts, transactions, date range, backup date) and must confirm. When data already exists, the confirmation clearly says it will replace all household data on this Mac.
5. The app copies the current data file, whatever its state, to `ledger.before-restore.age`, still encrypted with the old passphrase. It then saves the restored ledger with the normal atomic save, so the previous version is kept too.
6. After a restore, the household passphrase is the one used for the restore. The app says so if it differs from the one used to unlock.

**Safety rules:**
- Rust restores exactly the backup it decrypted and holds; the window cannot substitute other data.
- `restore_commit` without a just-opened backup is refused.
- Existing data can only be replaced from an unlocked household. A locked household can't be overwritten by a restore.
- A restore interrupted at any step leaves either the old data or the restored data, never neither or a mixture (tested at every step).
- Cancelling at either step changes nothing.
- Restore is also offered from the passphrase setup screen, for a new Mac.

**File panels:** they come from Tauri's dialog plugin, called **only from Rust**; the window has no dialog permission. The sandbox's `files.user-selected.read-write` entitlement lets the app touch only the file picked in a panel.

**Not yet built, or not verified:**
- **No in-app way to reopen `ledger.before-restore.age`.** It's kept so the replaced data isn't lost, but getting it back currently needs manual steps.
- **Decrypting a backup with the standalone `age` tool** (`age -d file.hmbackup`) is expected to work, since it's the standard format, but **it has not been tested.** That tool asks for the passphrase interactively, which CI can't provide.
- **The real save and open panels can't be clicked in CI.** The CI-only smoke build uses a fixed file in the container in their place. The panels themselves are first exercised on your Mac.
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
| No networking code ships | Script fails if the **macOS** dependency tree (`cargo tree --target aarch64-apple-darwin` and `x86_64-apple-darwin`) contains HTTP or socket crates (`reqwest`, `ureq`, `hyper`, `isahc`, `curl`, `rustls`, `mio`, `socket2`, network Tauri plugins and more) | CI |
| Permissions are as listed in §4 | Script checks the Tauri config (CSP, capabilities, plugin list, devtools off) and the entitlements file (exactly sandbox + `network.client`) | CI |
| Inside the packaged app's real window: renders; outside fetch blocked; outside navigation refused | CI-only smoke build runs an in-window probe (`scripts/macos-smoke-test.sh`) | macOS CI |
| The release build has exactly those entitlements, and no smoke-test code | `codesign -d --entitlements` and a binary scan (`scripts/macos-verify-app.sh`) | macOS CI |
| The running app opens no network connections | Launch the release app and confirm with `lsof -i` that neither it nor WebKit's helper processes hold any sockets | macOS CI |

**What these checks do not show:** macOS permits outgoing connections, so they cannot prove a different or compromised build would never connect. They check *this* build's code, configuration and observed behaviour. No separate firewall is required.

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
| **A. Mac shell** *(done)* | Wrap the existing UI in Tauri; App Sandbox (with `network.client`, required by WebKit); CSP, capabilities and navigation lock; config and crate checks; macOS CI build with entitlement and socket checks; delete the Pages deploy workflow | The app opens on your Mac showing today's welcome screen, and every network check passes |
| **B. Encrypted storage** *(done)* | Passphrase setup and unlock screen, lock and auto-lock, atomic save and load, previous-version fallback, single-writer lock, error messages | Storage, interruption and lock tests pass |
| **C. Backup and restore** *(done)* | Make a backup (household passphrase, read-back check), two-step restore with confirmation, pre-restore copy, file panels via Rust | Backup and restore tests pass, including interruption at every step, and a restore rehearsal on your Mac |
| **D. PDF import** | pdf.js, parser interface, synthetic layouts, scanned-PDF detection, review screen, diagnostics | Import tests pass |
| **E. Dashboard** | Overview, spending and income, comparisons, drilldowns, review queue, rules from corrections | Totals traceable; tests pass |
| **F. Go-live** | Checklist in §14 | You import real statements, on your Mac only |

**Getting the app onto your Mac** (no paid signing):
- The repo is public, so I expect GitHub's macOS runners to be free. That is from my own knowledge and has not been checked from here.
- CI builds one **universal** ad-hoc-signed `.app` (Intel + Apple Silicon, macOS 12 Monterey or later), zipped, and prints its SHA-256.
- **Compatibility checks in CI:** both processor types are present; `LSMinimumSystemVersion` is 12.0, and each half of the binary is compiled for macOS 12.0 or earlier. The smoke test runs the Apple Silicon half natively and the Intel half under Rosetta.
  - *Not verifiable in CI:* a real Intel Mac, or macOS 12 itself. GitHub's runners are newer Apple Silicon Macs, so the first launch on the household Mac is the real Monterey test. The artifact is kept for 7 days and contains only code.
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
| tauri 2.12.2, tauri-build 2.7.2 (Phase A) | Yes | Will carry IPC (no commands yet) | No network plugins. Its `reqwest` dependency is compiled only for iOS/Android, never for macOS (checked) | Exact versions pinned; `default-features = false` with only `wry` and `compression` |
| tauri-plugin-dialog 2.8.2 (Phase C) | Yes | Returns the chosen file path to Rust only | None. Its macOS tree adds `rfd` (native panels) and `tauri-plugin-fs` as a library (never registered); no networking crates (checked) | Official Tauri plugin; `gtk3` feature only affects Linux development builds |
| age 0.12.1 (Phase B) | Yes | Encrypts and decrypts everything | None. Its macOS dependency tree (about 90 crates, including unused post-quantum and translation crates) contains no networking crates (checked) | Format spec plus Go reference implementation; its cipher crate is NCC-audited; **no audit found for the crate itself**. No optional features. |
| @tauri-apps/api 2.12.2 (Phase B) | Yes | Carries the passphrase and ledger to and from Rust | None (zero dependencies; only `invoke` and `isTauri` are used) | Official Tauri JavaScript API, pinned to match the Rust crate |
| pdfjs-dist (planned, D) | Yes | Reads statements | Disabled; blocked by CSP and sandbox | Reviewed in Phase D |
| vite, vitest, typescript, @playwright/test, @types/node, @tauri-apps/cli | Dev only | Synthetic data only | Not shipped | — |

## 14. Household go-live checklist (before real statements)

- [ ] Phases A–E are complete, and `npm run verify` plus the Rust and macOS checks pass on the build you install.
- [ ] The built app's entitlements are exactly App Sandbox + `network.client`, and the macOS CI network checks passed on the build you install.
- [ ] Optional: the app works fully with Wi-Fi turned off.
- [ ] The household passphrase is chosen and stored safely (for example written down at home, or in a password manager).
- [ ] A backup was made, opened with `age -d`, and restored in a test, confirming recovery works.
- [ ] The checksum of the installed build matches the CI output.
- [ ] GitHub 2FA is on.
