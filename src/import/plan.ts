/**
 * The review step: what each read statement would add, before anything is
 * saved (PROJECT_PRINCIPLES.md §6–§7). `planStatements` is pure and is re-run
 * whenever the person changes an account choice. `applyImport` builds the new
 * ledger only when they confirm; the caller saves it in one atomic save.
 */
import { findRefundOriginal } from '../domain/refunds';
import { dedupeKey, findStatementOverlaps, planDeduplication, type ExistingTransaction } from '../domain/dedupe';
import type { DateRange } from '../domain/dates';
import { matchTransfers } from '../domain/transfers';
import type { Account, AccountKind, Id, Statement, Transaction } from '../domain/types';
import type { LedgerDocument } from '../storage/ledger';
import { classify, merchantFrom } from './classify';
import type { ParsedStatement, ParsedTransaction } from './parsers/types';

export interface StatementInput {
  fileName: string;
  sha256: string;
  statement: ParsedStatement;
}

/** Statements choosing the same `key` share one new account (e.g. March and April). */
export type AccountChoice =
  | { type: 'existing'; accountId: Id }
  | { type: 'new'; key: string; displayName: string; kind: AccountKind; last4?: string };

export type RowStatus = 'new' | 'duplicate' | 'check' | 'unusable';

export interface DraftRow {
  transaction: ParsedTransaction;
  status: RowStatus;
  /** Plain-language reasons shown on the review screen. */
  reasons: string[];
  include: boolean;
  /** For duplicates: the transaction already recorded. */
  existingId?: Id;
}

export interface DraftStatement {
  input: StatementInput;
  account: AccountChoice;
  alreadyImported: boolean;
  rows: DraftRow[];
}

const KIND_NAMES: Record<AccountKind, string> = { checking: 'Checking', savings: 'Savings', credit_card: 'Credit card' };

export function accountKey(choice: AccountChoice): string {
  return choice.type === 'existing' ? choice.accountId : `new:${choice.key}`;
}

/** An existing account with the same kind and last four digits, else a new one. */
export function suggestAccount(ledger: LedgerDocument, statement: ParsedStatement, index: number): AccountChoice {
  const match = ledger.accounts.find(
    (a) => !a.archived && a.last4 !== undefined && a.last4 === statement.last4 && (!statement.accountKind || a.kind === statement.accountKind),
  );
  if (match) return { type: 'existing', accountId: match.id };
  const kind = statement.accountKind ?? 'checking';
  const name = `${KIND_NAMES[kind]}${statement.last4 ? ` ending ${statement.last4}` : ''}`;
  return {
    type: 'new',
    key: statement.last4 ? `${kind}:${statement.last4}` : `file:${index}`,
    displayName: name,
    kind,
    ...(statement.last4 ? { last4: statement.last4 } : {}),
  };
}

export function planStatements(ledger: LedgerDocument, inputs: { input: StatementInput; account: AccountChoice }[]): DraftStatement[] {
  const coveredByAccount = new Map<string, DateRange[]>();
  const knownByAccount = new Map<string, ExistingTransaction[]>();
  for (const statement of ledger.statements) {
    const list = coveredByAccount.get(statement.accountId) ?? [];
    list.push({ start: statement.periodStart, end: statement.periodEnd });
    coveredByAccount.set(statement.accountId, list);
  }
  for (const t of ledger.transactions) {
    const list = knownByAccount.get(t.accountId) ?? [];
    list.push({ id: t.id, accountId: t.accountId, postedDate: t.postedDate, amountCents: t.amountCents, originalDescription: t.originalDescription });
    knownByAccount.set(t.accountId, list);
  }
  // A file is identified by its fingerprint and, for a combined statement, the account section within it.
  const fileKey = (sha256: string, section: number | undefined) => `${sha256}#${section ?? 0}`;
  const seenFiles = new Set(ledger.statements.map((s) => fileKey(s.fileSha256, s.fileSection)));

  return inputs.map(({ input, account }, statementIndex) => {
    const key = accountKey(account);
    const parsed = input.statement;
    const thisFile = fileKey(input.sha256, input.statement.section?.index);
    const alreadyImported = seenFiles.has(thisFile);
    seenFiles.add(thisFile);

    const usable = parsed.transactions.filter((t) => t.amountCents !== null);
    const candidates = usable.map((t, i) => ({
      accountId: key,
      postedDate: t.postedDate,
      amountCents: t.amountCents!,
      originalDescription: t.description,
      source: t,
      provisionalId: `batch:${statementIndex}:${i}`,
    }));
    const verdicts = planDeduplication(candidates, knownByAccount.get(key) ?? [], new Map([[key, coveredByAccount.get(key) ?? []]]));
    const byTransaction = new Map(verdicts.map((v) => [v.candidate.source, v]));

    const rows: DraftRow[] = parsed.transactions.map((t) => {
      if (alreadyImported) {
        return { transaction: t, status: 'duplicate', reasons: ['This statement file was already added'], include: false };
      }
      if (t.amountCents === null) {
        return { transaction: t, status: 'unusable', reasons: ["Couldn't tell whether this money came in or went out"], include: false };
      }
      const verdict = byTransaction.get(t)!;
      if (verdict.status === 'duplicate') {
        return { transaction: t, status: 'duplicate', reasons: ['Already in your records'], include: false, existingId: verdict.existingId };
      }
      const reasons: string[] = [];
      if (verdict.status === 'new_in_covered_period') reasons.push('Falls in a period already added: check it is not a duplicate');
      if (t.flags.includes('date_assigned')) reasons.push("No date was printed for this line, so the statement's closing date was used");
      if (t.flags.includes('date_outside_period')) reasons.push("Date is outside the statement's period");
      if (t.flags.includes('running_balance_mismatch')) reasons.push("Doesn't match the statement's running balance");
      return { transaction: t, status: reasons.length ? 'check' : 'new', reasons, include: true };
    });

    // Later statements in this batch see this one's rows and period.
    if (!alreadyImported) {
      const covered = coveredByAccount.get(key) ?? [];
      covered.push({ start: parsed.periodStart, end: parsed.periodEnd });
      coveredByAccount.set(key, covered);
      const known = knownByAccount.get(key) ?? [];
      rows.forEach((row) => {
        if (row.include && row.transaction.amountCents !== null) {
          const c = candidates.find((x) => x.source === row.transaction)!;
          known.push({ id: c.provisionalId, accountId: key, postedDate: c.postedDate, amountCents: c.amountCents, originalDescription: c.originalDescription });
        }
      });
      knownByAccount.set(key, known);
    }
    return { input, account, alreadyImported, rows };
  });
}

/** Overlapping periods already in the ledger, for the review screen. */
export function overlapsWithLedger(ledger: LedgerDocument, draft: DraftStatement): number {
  if (draft.account.type !== 'existing') return 0;
  return findStatementOverlaps(
    { accountId: draft.account.accountId, periodStart: draft.input.statement.periodStart, periodEnd: draft.input.statement.periodEnd, fileSha256: draft.input.sha256 },
    ledger.statements,
  ).filter((o) => o.type === 'overlapping_period').length;
}

export interface ImportResult {
  ledger: LedgerDocument;
  added: number;
  statements: number;
  needsReview: number;
}

/**
 * Builds the new ledger from the confirmed drafts. Nothing is saved here.
 * Corrections the person made earlier (classification source "user") are
 * never changed.
 */
export function applyImport(
  ledger: LedgerDocument,
  drafts: DraftStatement[],
  options: { now: Date; newId: () => Id },
): ImportResult {
  const next: LedgerDocument = structuredClone(ledger);
  const batchId = options.newId();
  const importedAt = options.now.toISOString();
  const accountIds = new Map<string, Id>();
  const kindOf = new Map(next.accounts.map((a) => [a.id, a.kind]));
  const added: Transaction[] = [];
  let statements = 0;

  for (const draft of drafts) {
    if (draft.alreadyImported || !draft.rows.some((r) => r.include)) continue;
    const key = accountKey(draft.account);
    let accountId = accountIds.get(key);
    if (!accountId) {
      if (draft.account.type === 'existing') {
        accountId = draft.account.accountId;
      } else {
        accountId = options.newId();
        const account: Account = {
          id: accountId,
          displayName: draft.account.displayName.trim() || KIND_NAMES[draft.account.kind],
          kind: draft.account.kind,
          institution: '',
          parserId: draft.input.statement.parserId,
          archived: false,
          ...(draft.account.last4 ? { last4: draft.account.last4 } : {}),
        };
        next.accounts.push(account);
        kindOf.set(accountId, account.kind);
      }
      accountIds.set(key, accountId);
    }
    const parsed = draft.input.statement;
    const statement: Statement = {
      id: options.newId(),
      accountId,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      ...(parsed.openingBalanceCents !== undefined ? { openingBalanceCents: parsed.openingBalanceCents } : {}),
      ...(parsed.closingBalanceCents !== undefined ? { closingBalanceCents: parsed.closingBalanceCents } : {}),
      fileSha256: draft.input.sha256,
      ...(parsed.section ? { fileSection: parsed.section.index } : {}),
      parserId: parsed.parserId,
      parserVersion: parsed.parserVersion,
      transactionCount: parsed.transactions.length,
      validation: parsed.validation,
      importedAt,
      importBatchId: batchId,
    };
    next.statements.push(statement);
    statements++;

    for (const row of draft.rows) {
      if (row.status === 'duplicate' && row.existingId) {
        // The same line printed on an overlapping statement: record that it appeared here too.
        const existing = next.transactions.find((t) => t.id === row.existingId);
        if (existing && !existing.statementIds.includes(statement.id)) existing.statementIds.push(statement.id);
        continue;
      }
      if (!row.include || row.transaction.amountCents === null) continue;
      const t = row.transaction;
      const first = classify({ amountCents: t.amountCents!, description: t.description }, kindOf.get(accountId)!);
      const transaction: Transaction = {
        id: options.newId(),
        accountId,
        statementIds: [statement.id],
        postedDate: t.postedDate,
        ...(t.transactionDate ? { transactionDate: t.transactionDate } : {}),
        amountCents: t.amountCents!,
        originalDescription: t.description,
        merchant: merchantFrom(t.description),
        kind: first.kind,
        classification: { categoryId: first.categoryId, source: 'heuristic', confidence: first.confidence, reasons: [...first.reasons, ...row.reasons] },
        needsReview: first.needsReview || row.status === 'check',
        dedupeKey: dedupeKey({ accountId, postedDate: t.postedDate, amountCents: t.amountCents!, originalDescription: t.description }),
      };
      next.transactions.push(transaction);
      added.push(transaction);
    }
  }

  linkTransfers(next, new Set(added.map((t) => t.id)), options.newId);
  linkRefunds(next, added);
  return { ledger: next, added: added.length, statements, needsReview: added.filter((t) => t.needsReview).length };
}

/** Pairs both sides of transfers and card payments that involve a new transaction. */
function linkTransfers(ledger: LedgerDocument, newIds: Set<Id>, newId: () => Id): void {
  const editable = (t: Transaction) => t.classification.source !== 'user';
  const { proposals, ambiguous } = matchTransfers(ledger.transactions, ledger.accounts);
  const byId = new Map(ledger.transactions.map((t) => [t.id, t]));
  for (const proposal of proposals) {
    if (!proposal.confident || (!newIds.has(proposal.outflowId) && !newIds.has(proposal.inflowId))) continue;
    const pair = [byId.get(proposal.outflowId)!, byId.get(proposal.inflowId)!];
    if (!pair.every(editable)) continue;
    const groupId = newId();
    for (const t of pair) {
      t.kind = proposal.kind;
      t.transferGroupId = groupId;
      t.classification = {
        categoryId: proposal.kind === 'card_payment' ? 'xfer.card_payment' : 'xfer.internal',
        source: 'heuristic',
        confidence: 0.9,
        reasons: proposal.reasons,
      };
      t.needsReview = false;
    }
  }
  for (const item of ambiguous) {
    const t = byId.get(item.transactionId);
    if (t && newIds.has(t.id) && editable(t) && (t.kind === 'transfer' || t.kind === 'card_payment')) {
      t.needsReview = true;
      t.classification.reasons.push('Could match more than one transaction in another account');
    }
  }
}

/** Gives card refunds the category of the purchase they reverse. */
function linkRefunds(ledger: LedgerDocument, added: Transaction[]): void {
  for (const refund of added) {
    if (refund.kind !== 'refund') continue;
    const merchant = refund.merchant;
    const link = findRefundOriginal({ ...refund, merchant }, ledger.transactions);
    if (link.status === 'linked') {
      refund.refundOfTransactionId = link.originalId;
      refund.classification = {
        categoryId: link.categoryId,
        source: 'heuristic',
        confidence: link.exactAmount ? 0.8 : 0.6,
        reasons: ['Refund of an earlier purchase: reduces that spending'],
      };
      refund.needsReview = !link.exactAmount;
    } else if (link.status === 'ambiguous') {
      refund.classification.reasons.push('Could be a refund of more than one purchase');
    }
  }
}
