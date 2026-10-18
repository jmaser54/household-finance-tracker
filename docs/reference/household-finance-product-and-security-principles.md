> **Reference only. Superseded by [`PROJECT_PRINCIPLES.md`](../../PROJECT_PRINCIPLES.md)**, which is the canonical source of truth. This copy is kept unchanged for history; do not develop against it.

# Household Finance Tracker — Product & Security Principles

**Status:** Foundational project source document  
**Priority:** These principles govern all implementation decisions. If a proposed feature conflicts with the privacy requirements, privacy wins.

## 1. Non-negotiable: financial data privacy

- **Financial data must be accessible only to the household user operating the app. Never expose one user's statements, transactions, account details, or derived financial information to another user.**
- If the project cannot meet this requirement with a reasonable, defensible security design, do not ship it.
- Prefer a local-first architecture: process statements on the user's device and store the household ledger in that browser's local database.
- Do not send statements, transaction descriptions, balances, categories, or financial summaries to third-party services, AI APIs, analytics platforms, or telemetry systems.
- Do not connect to banks or financial aggregators.
- Do not commit statements, backups, transaction data, credentials, account numbers, or other private household data to GitHub.
- Treat GitHub Pages as a host for application code only, never as a private financial-data store.
- Minimize dependencies and external scripts. Review any dependency that can access imported files or transaction data.
- Be honest: no application can promise a literal zero-percent chance of compromise. Design to minimize exposure and clearly document residual risks.
- Local browser storage is not automatically equivalent to encrypted storage. Provide an explicit, secure backup/export design and explain its limitations.
- Prefer encrypted backups using a strong, user-chosen passphrase. Do not store the passphrase in the app or in the backup. If encrypted backup/restore cannot be implemented safely, explain the trade-off rather than pretending a plain file is encrypted.
- Never include financial data in error reports, console output, URLs, browser analytics, or diagnostic logs.

## 2. Product goal

Build a household spending and income tracker for a married couple who consider their finances jointly, even though they have separate accounts. The initial application is primarily for one household and one browser/device. Keep the architecture adaptable for future sharing, but do not build multi-user accounts, cloud sync, or a backend unless there is a compelling future need.

This is a spending-analysis tool first, not a complete personal-finance suite. Do not add investments, bill payment, bank linking, debt payoff planning, or mandatory budgeting in the initial version.

## 3. User experience and visual direction

- Optimize for clarity, confidence, and approachability above feature count.
- The experience should feel warm, friendly, patient, and lightly playful, inspired by the welcoming, cartoonish feel of early-1990s Backyard Baseball games.
- Do not make the interface childish, patronizing, cluttered, or gimmicky. The financial analysis must remain accurate and useful.
- Avoid the overwhelming feel of traditional finance dashboards: no dense wall of figures, excessive decimals, piles of charts, unnecessary tabs, widget builders, or accounting jargon.
- The initial screen should be simple: upload statement PDFs and show a small, attractive preview/mockup of the kind of household dashboard the user will see after importing.
- Do not build a marketing homepage, product tour, demo flow, or unnecessary terms-of-service page for the initial household-only tool.
- After importing and confirming statements, take the user directly to the updated household dashboard.
- Use progressive disclosure: a simple overview first, with deeper transaction/category details available when requested.
- Make important actions and states obvious: what has been imported, what needs review, when data was last backed up, and whether an import completed successfully.

## 4. Initial workflow and data storage

- Support PDF statements only in the first version.
- Prefer text-based PDFs that can be parsed locally in the browser. Detect scanned/image-only PDFs and clearly explain when they are unsupported; do not silently guess or claim success.
- Do not transmit PDFs to an external service for extraction or OCR.
- The user expects to provide six months of historical statements during initial development/testing. Treat any real statements as sensitive data; never commit them to the repository.
- Use browser-local structured storage such as IndexedDB for the ledger, rather than relying on small key/value storage.
- Provide robust backup and restore, including transactions, accounts, categories, merchant rules, settings, and schema/version metadata.
- Strongly prefer encrypted backup files protected by a user-chosen passphrase, with encryption performed locally. Do not claim encryption unless it is actually implemented and tested.
- Provide validation and clear warnings before restoring or replacing existing data.
- Include a practical migration path for moving to a new computer/browser by restoring a backup.
- Local browser storage is device/browser/origin-specific and may be deleted. Explain this clearly and make backup reminders useful but unobtrusive.
- No automatic cross-device synchronization in version one.

## 5. Accounts and household model

- Treat the couple's accounts and transactions as one joint household for reporting.
- Retain account identity internally so transfers and duplicate transactions can be identified.
- Initial account coverage: checking, savings, and credit cards.
- Design account names and categories as settings, not hardcoded personal details.
- Do not store bank login credentials.

## 6. Financial definitions and transaction rules

- Spending is based on underlying purchases and charges, not movements of money between accounts.
- Credit-card purchases count as spending when charged. Credit-card bill payments from checking are transfers/payments, not additional spending.
- Transfers between the household's own checking and savings accounts are not income or spending.
- Moving money into savings is not household spending.
- Employment income from both spouses is combined into one Employment Income category.
- Family gifts are categorized separately from employment income.
- Business refunds should reduce the original expense category when the original purchase can be identified. If it cannot, flag it for review rather than automatically inflating ordinary income.
- Actual net cash flow means recognized income minus recognized expenses. It is not the same as the change in a checking-account balance.
- Keep transfers visible as a distinct transaction type when useful, but exclude them from income and expense totals.
- Cash withdrawals may be classified as Cash / Untracked Cash Spending. Do not require the user to explain what cash was used for.
- Offer optional user annotations or reclassification for a withdrawal (for example, a cash gift). Never force this.
- Avoid double-counting transactions that appear in overlapping statements or across accounts.

## 7. Categorization principles

- Start with a sensible, recognizable category taxonomy inspired by common consumer-finance categories, then tailor it to the actual household statements.
- Keep meaningful household-specific expenses, including childcare/school payments, as their own visible category.
- Use a small number of useful top-level categories with optional subcategories. Avoid making the default interface too granular.
- Include an Other category, but do not use it as a substitute for good categorization.
- If a substantial share of transactions or spending remains in Other/Uncategorized, surface that as a quality issue to fix.
- Categorize income separately from expenses.
- Distinguish employment income, family gifts, refunds/reimbursements, interest/investment income (if present), and other income.
- Never assume a credit is employment income merely because it comes from a company name, or a gift merely because the description contains a person's name or a shared surname.
- Use evidence from transaction description, direction, amount, recurrence, account, statement context, and prior user corrections. Assign confidence; uncertain transactions should be flagged for review.
- Learn from explicit corrections through editable merchant/rule mappings. Do not silently overwrite prior corrections on future imports.
- Support renaming/merging merchant labels, changing categories, and optionally splitting a transaction across categories.
- The user expects to import six months of historical statements into the finished app. Real statements must be imported directly into the local app, not committed to the repository. Do not upload actual statements to Claude Code or another AI service unless the user explicitly decides to accept that third-party processing. Prefer synthetic or carefully redacted samples for parser development; merchant descriptions and transaction patterns can themselves be sensitive. Validate categorization against actual examples inside the local app rather than sending the full ledger to an AI service.

## 8. Import quality and auditability

- Show extracted transactions and classifications for review before final import.
- Validate statement date ranges, transaction counts, and opening/closing balance or summary totals when available.
- Clearly identify unreadable PDFs, unsupported layouts, uncertain extraction, and missing data.
- Do not silently omit rows or invent transaction details.
- Repeated imports and overlapping statement periods must not duplicate transactions.
- Each dashboard total must be traceable to its underlying transactions.
- Preserve original statement descriptions alongside normalized merchant names.
- Keep import operations reversible where practical and clearly show what will be added or changed.

## 9. Dashboard and reporting

- Make it easy to answer: Where are we spending the most? How much do we spend by week/month/year/custom period? Are recognized income and expenses net positive or negative? What changed versus the prior period? What are the biggest contributors?
- Provide a separate incoming-money section rather than mixing income sources into the expense category list.
- Show ordinary employment income separately from exceptional inflows such as family gifts and one-time refunds, while still reflecting correctly classified transactions in overall cash-flow calculations.
- Default to a clear summary, simple visualizations, readable rounded numbers, and direct drilldown to transactions.
- Support custom date ranges and comparisons without cluttering the first screen.
- Budgets are deferred; do not require the user to set monthly spending limits.

## 10. Engineering and release expectations

- Start by inspecting the empty repository and proposing a concise implementation plan.
- Build in phases: data model and tested calculations; local PDF parsing and import review; local persistence and encrypted backups; dashboard and drilldowns; polish and end-to-end validation.
- Keep PDF parsers, transaction normalization, categorization, duplicate detection, calculations, and UI separate enough to test independently.
- Include tests for transfers, credit-card payments, gifts, refunds, cash withdrawals, duplicate imports, uncertain categories, and net cash-flow calculations.
- Use synthetic fixtures for automated tests. Real household statements must not enter the repository, test snapshots, screenshots, logs, or CI artifacts.
- Verify production builds and tests before committing/pushing changes. Do not add a backend, analytics, remote AI, or synchronization without explicit approval.
- Keep the project easy to extend, but do not over-engineer for hypothetical users before the household workflow works reliably.
