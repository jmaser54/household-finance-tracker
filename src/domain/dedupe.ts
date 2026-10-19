/**
 * Duplicate and overlap detection for imports (PROJECT_PRINCIPLES.md §6, §7).
 *
 * Design: inside a date range an account's ledger already covers, incoming
 * transactions are matched against existing ones as a *multiset* keyed by
 * (account, posted date, amount, normalized description). If the ledger holds
 * n identical lines and the new statement has m, only max(0, m − n) are new,
 * so two genuine identical purchases on one day both survive while re-imports
 * add nothing. Nothing is merged on a near-match; it is flagged for review.
 */
import { daysBetween, inRange, overlap, type DateRange } from './dates';
import type { Cents } from './money';
import type { Id, IsoDate, Statement } from './types';

/** The fields of a not-yet-saved transaction that dedupe needs. */
export interface DedupeCandidate {
  accountId: Id;
  postedDate: IsoDate;
  amountCents: Cents;
  originalDescription: string;
}

export interface ExistingTransaction extends DedupeCandidate {
  id: Id;
}

/** Case and whitespace insensitive; otherwise the description is kept as printed. */
export function normalizeDescription(description: string): string {
  return description.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();
}

export function dedupeKey(candidate: DedupeCandidate): string {
  return [
    candidate.accountId,
    candidate.postedDate,
    String(candidate.amountCents),
    normalizeDescription(candidate.originalDescription),
  ].join('\u001f');
}

export type StatementOverlap =
  | { type: 'same_file'; statementId: Id }
  | { type: 'overlapping_period'; statementId: Id; range: DateRange };

/** How a statement about to be imported relates to statements already in the ledger. */
export function findStatementOverlaps(
  incoming: Pick<Statement, 'accountId' | 'periodStart' | 'periodEnd' | 'fileSha256'>,
  existing: readonly Statement[],
): StatementOverlap[] {
  const results: StatementOverlap[] = [];
  for (const statement of existing) {
    if (statement.fileSha256 === incoming.fileSha256) {
      results.push({ type: 'same_file', statementId: statement.id });
      continue;
    }
    if (statement.accountId !== incoming.accountId) continue;
    const range = overlap(
      { start: incoming.periodStart, end: incoming.periodEnd },
      { start: statement.periodStart, end: statement.periodEnd },
    );
    if (range) results.push({ type: 'overlapping_period', statementId: statement.id, range });
  }
  return results;
}

export type CandidateVerdict<T> =
  /** Outside any period already imported for this account. */
  | { status: 'new'; candidate: T }
  /** Inside an imported period with no exact match: kept, but flagged so the user can check. */
  | { status: 'new_in_covered_period'; candidate: T; possibleMatchIds: Id[] }
  /** Exactly matches an existing transaction not already claimed by another candidate. */
  | { status: 'duplicate'; candidate: T; existingId: Id };

export interface DedupeOptions {
  /** Near-match window for flagging possible duplicates whose dates differ. */
  nearMatchDays?: number;
}

/**
 * Classifies each incoming candidate. `coveredRanges` are the statement periods
 * already imported for the candidate's account (use `findStatementOverlaps`).
 * Order and count of candidates are preserved: every input appears in the output.
 */
export function planDeduplication<T extends DedupeCandidate>(
  candidates: readonly T[],
  existing: readonly ExistingTransaction[],
  coveredRanges: ReadonlyMap<Id, readonly DateRange[]>,
  options: DedupeOptions = {},
): CandidateVerdict<T>[] {
  const nearMatchDays = options.nearMatchDays ?? 3;

  // Existing transactions grouped by key, consumed as candidates claim them.
  const unclaimed = new Map<string, ExistingTransaction[]>();
  for (const transaction of existing) {
    const key = dedupeKey(transaction);
    const list = unclaimed.get(key) ?? [];
    list.push(transaction);
    unclaimed.set(key, list);
  }
  const claimed = new Set<Id>();

  return candidates.map((candidate) => {
    const ranges = coveredRanges.get(candidate.accountId) ?? [];
    if (!ranges.some((range) => inRange(candidate.postedDate, range))) {
      return { status: 'new', candidate };
    }

    const match = unclaimed.get(dedupeKey(candidate))?.shift();
    if (match) {
      claimed.add(match.id);
      return { status: 'duplicate', candidate, existingId: match.id };
    }

    const possibleMatchIds = existing
      .filter(
        (t) =>
          !claimed.has(t.id) &&
          t.accountId === candidate.accountId &&
          t.amountCents === candidate.amountCents &&
          Math.abs(daysBetween(t.postedDate, candidate.postedDate)) <= nearMatchDays,
      )
      .map((t) => t.id);
    return { status: 'new_in_covered_period', candidate, possibleMatchIds };
  });
}
