import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatExact } from '../domain/money';
import type { AccountKind } from '../domain/types';
import { newId } from '../import/ids';
import type { ParsedStatement } from '../import/parsers/types';
import { MAX_PDF_BYTES, type PdfJs } from '../import/pdfText';
import {
  applyImport,
  overlapsWithLedger,
  planStatements,
  suggestAccount,
  type AccountChoice,
  type DraftStatement,
  type ImportResult,
  type RowStatus,
} from '../import/plan';
import { fingerprint, readStatement, type FileOutcome } from '../import/readStatement';
import type { LedgerDocument } from '../storage/ledger';
import { formatDay } from './Backup';
import { Header } from './Header';

interface ReadFile {
  name: string;
  outcome: FileOutcome | { status: 'reading' } | { status: 'too_large' };
  sha256?: string;
}

const FAILURE_TEXT: Record<string, string> = {
  not_pdf: "This file isn't a PDF.",
  too_large: 'This file is too large to be a statement.',
  unreadable: "This PDF couldn't be opened. It may be damaged.",
  password_protected:
    'This PDF is password-protected. Open it, save a copy without a password, and add that copy instead.',
  scanned:
    "This PDF is a scanned picture of a statement, so its text can't be read. Scanned statements aren't supported yet. Download the statement from your bank's website as a PDF instead.",
  no_period:
    "We couldn't find the statement period in this PDF, so its dates can't be placed. It may be a layout the app doesn't read yet.",
  no_transactions: "We couldn't find a list of transactions in this PDF. It may be a layout the app doesn't read yet.",
};

const STATUS_LABEL: Record<RowStatus, string> = {
  new: 'New',
  duplicate: 'Already added',
  check: 'Check this',
  unusable: "Can't use",
};

const KIND_LABEL: Record<AccountKind, string> = { checking: 'Checking', savings: 'Savings', credit_card: 'Credit card' };

function shortDay(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function Diagnostics({ lines }: { lines: string[] }) {
  return (
    <details class="diagnostics">
      <summary>Show what the app saw (all values hidden)</summary>
      <p class="hint">
        Dates, amounts, numbers and words are replaced by DATE, AMOUNT, NUMBER and TEXT. Only layout words like
        "Balance" remain. This is shown here only and never leaves this Mac.
      </p>
      <pre>{lines.join('\n')}</pre>
    </details>
  );
}

export function ImportScreen({
  ledger,
  files,
  pdfjs,
  onCancel,
  onConfirm,
}: {
  ledger: LedgerDocument;
  files: File[];
  pdfjs: () => Promise<PdfJs>;
  onCancel: () => void;
  onConfirm: (result: ImportResult) => Promise<string | null>;
}) {
  const [read, setRead] = useState<ReadFile[]>(files.map((f) => ({ name: f.name, outcome: { status: 'reading' } })));
  const [choices, setChoices] = useState<Map<number, AccountChoice>>(new Map());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [acceptedFailures, setAcceptedFailures] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lib = await pdfjs();
      for (let i = 0; i < files.length; i++) {
        const file = files[i]!;
        let entry: ReadFile;
        if (file.size > MAX_PDF_BYTES) entry = { name: file.name, outcome: { status: 'too_large' } };
        else {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const [sha256, outcome] = await Promise.all([fingerprint(bytes), readStatement(bytes, lib)]);
          entry = { name: file.name, outcome, sha256 };
        }
        if (cancelled) return;
        setRead((current) => current.map((r, j) => (j === i ? entry : r)));
      }
    })().catch(() => {
      if (!cancelled) setRead((current) => current.map((r) => (r.outcome.status === 'reading' ? { ...r, outcome: { status: 'unreadable' } } : r)));
    });
    return () => {
      cancelled = true;
    };
  }, [files, pdfjs]);

  const parsedIndexes = read.flatMap((r, i) => (r.outcome.status === 'parsed' ? [i] : []));
  const reading = read.some((r) => r.outcome.status === 'reading');

  const drafts: (DraftStatement & { fileIndex: number })[] = useMemo(() => {
    const inputs = parsedIndexes.map((i, n) => {
      const file = read[i]!;
      const statement = (file.outcome as { statement: ParsedStatement }).statement;
      return {
        input: { fileName: file.name, sha256: file.sha256!, statement },
        account: choices.get(i) ?? suggestAccount(ledger, statement, n),
      };
    });
    return planStatements(ledger, inputs).map((draft, n) => {
      const fileIndex = parsedIndexes[n]!;
      const blocked = draft.input.statement.validation.status === 'failed' && !acceptedFailures.has(fileIndex);
      return {
        ...draft,
        fileIndex,
        rows: draft.rows.map((row, r) => ({
          ...row,
          include: row.include && !blocked && !excluded.has(`${fileIndex}:${r}`),
        })),
      };
    });
  }, [read, choices, excluded, acceptedFailures, ledger]);

  const toAdd = drafts.reduce((n, d) => n + d.rows.filter((r) => r.include).length, 0);
  const missingNames = drafts.some((d) => d.account.type === 'new' && d.account.displayName.trim() === '');

  const setChoice = (fileIndex: number, choice: AccountChoice) => setChoices((m) => new Map(m).set(fileIndex, choice));
  const toggleRow = (key: string) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const result = applyImport(ledger, drafts, { now: new Date(), newId });
    const problem = await onConfirm(result);
    setBusy(false);
    if (problem) setError(problem);
  };

  return (
    <main class="import-screen">
      <Header />
      <section class="import-intro" data-screen="import">
        <h2>Check what we found</h2>
        <p>
          Your statements were read on this Mac and aren't kept. Nothing is added to your records until you click the
          button at the bottom.
        </p>
      </section>

      {read.map((file, fileIndex) => {
        const outcome = file.outcome;
        if (outcome.status === 'reading') {
          return (
            <section class="import-card" key={fileIndex} aria-busy="true">
              <h3>{file.name}</h3>
              <p class="hint">Reading…</p>
            </section>
          );
        }
        if (outcome.status !== 'parsed') {
          const reason = outcome.status === 'unsupported' ? outcome.reason : outcome.status;
          return (
            <section class="import-card import-failed" key={fileIndex} data-file-status={outcome.status}>
              <h3>{file.name}</h3>
              <p class="form-error">{FAILURE_TEXT[reason] ?? FAILURE_TEXT.unreadable}</p>
              {outcome.status === 'unsupported' && <Diagnostics lines={outcome.diagnostics} />}
            </section>
          );
        }
        const draft = drafts.find((d) => d.fileIndex === fileIndex)!;
        return (
          <StatementCard
            key={fileIndex}
            ledger={ledger}
            draft={draft}
            diagnostics={outcome.diagnostics}
            fileName={file.name}
            onChoice={(choice) => setChoice(fileIndex, choice)}
            acceptedFailure={acceptedFailures.has(fileIndex)}
            onAcceptFailure={(accepted) =>
              setAcceptedFailures((s) => {
                const next = new Set(s);
                if (accepted) next.add(fileIndex);
                else next.delete(fileIndex);
                return next;
              })
            }
            onToggleRow={(r) => toggleRow(`${fileIndex}:${r}`)}
          />
        );
      })}

      <section class="import-footer">
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <div class="button-row">
          <button type="button" class="primary-button" disabled={busy || reading || toAdd === 0 || missingNames} onClick={confirm}>
            {busy ? 'Adding…' : reading ? 'Reading statements…' : `Add ${toAdd} ${toAdd === 1 ? 'transaction' : 'transactions'}`}
          </button>
          <button type="button" class="secondary-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
        {missingNames && <p class="hint">Give each new account a name first.</p>}
      </section>
    </main>
  );
}

function StatementCard({
  ledger,
  draft,
  diagnostics,
  fileName,
  onChoice,
  acceptedFailure,
  onAcceptFailure,
  onToggleRow,
}: {
  ledger: LedgerDocument;
  draft: DraftStatement;
  diagnostics: string[];
  fileName: string;
  onChoice: (choice: AccountChoice) => void;
  acceptedFailure: boolean;
  onAcceptFailure: (accepted: boolean) => void;
  onToggleRow: (row: number) => void;
}) {
  const s = draft.input.statement;
  const counts = { new: 0, duplicate: 0, check: 0, unusable: 0 } as Record<RowStatus, number>;
  for (const row of draft.rows) counts[row.status]++;
  const account = draft.account;
  const status = s.validation.status;
  const overlaps = overlapsWithLedger(ledger, draft);

  return (
    <section class="import-card" data-file-status="parsed">
      <h3>{fileName}</h3>
      <p class="statement-facts">
        {KIND_LABEL[s.accountKind ?? 'checking']}
        {s.last4 ? ` ending ${s.last4}` : ''} · {formatDay(s.periodStart)} to {formatDay(s.periodEnd)}
      </p>

      <label class="account-choice">
        Add to
        <select
          value={account.type === 'existing' ? account.accountId : 'new'}
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (value === 'new') {
              const kind = s.accountKind ?? 'checking';
              onChoice({ type: 'new', key: `manual:${fileName}`, displayName: `${KIND_LABEL[kind]}${s.last4 ? ` ending ${s.last4}` : ''}`, kind, ...(s.last4 ? { last4: s.last4 } : {}) });
            } else onChoice({ type: 'existing', accountId: value });
          }}
        >
          {ledger.accounts
            .filter((a) => !a.archived)
            .map((a) => (
              <option value={a.id} key={a.id}>
                {a.displayName}
              </option>
            ))}
          <option value="new">A new account…</option>
        </select>
      </label>
      {account.type === 'new' && (
        <div class="new-account">
          <label>
            Account name
            <input value={account.displayName} onInput={(e) => onChoice({ ...account, displayName: e.currentTarget.value })} />
          </label>
          <label>
            Type
            <select value={account.kind} onChange={(e) => onChoice({ ...account, kind: e.currentTarget.value as AccountKind })}>
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
              <option value="credit_card">Credit card</option>
            </select>
          </label>
        </div>
      )}

      {draft.alreadyImported ? (
        <p class="notice">This statement was already added, so nothing from it will be added again.</p>
      ) : (
        <>
          {status === 'verified' && <p class="form-success">✓ Every line was read and the balances match the statement.</p>}
          {status === 'partially_verified' && <p class="hint">The balances were checked, but not every line could be confirmed.</p>}
          {status === 'unverified' && (
            <p class="hint">This statement doesn't print opening and closing balances, so the totals couldn't be checked.</p>
          )}
          {status === 'failed' && (
            <div class="warning">
              <p>
                <strong>These transactions don't add up to the statement's balances.</strong> Some lines may not have
                been read correctly, so nothing from this statement is added unless you choose to.
              </p>
              <label class="checkbox">
                <input type="checkbox" checked={acceptedFailure} onChange={(e) => onAcceptFailure(e.currentTarget.checked)} />
                I've checked these transactions; add them anyway
              </label>
            </div>
          )}
          {overlaps > 0 && <p class="hint">This statement overlaps one already added. Lines already in your records are skipped.</p>}
          {s.unreadLines.length > 0 && (
            <p class="form-error">
              {s.unreadLines.length} {s.unreadLines.length === 1 ? 'line looked' : 'lines looked'} like a transaction but
              couldn't be read, so {s.unreadLines.length === 1 ? 'it is' : 'they are'} not listed.
            </p>
          )}
        </>
      )}

      <p class="row-counts">
        {counts.new} new · {counts.duplicate} already added
        {counts.check > 0 && ` · ${counts.check} to check`}
        {counts.unusable > 0 && ` · ${counts.unusable} can't use`}
      </p>

      <table class="review-table">
        <thead>
          <tr>
            <th scope="col">Add</th>
            <th scope="col">Date</th>
            <th scope="col">Description</th>
            <th scope="col" class="num">
              Amount
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {draft.rows.map((row, r) => {
            const amount = row.transaction.amountCents;
            const locked = row.status === 'duplicate' || row.status === 'unusable' || draft.alreadyImported;
            return (
              <tr key={r} class={`row-${row.status}`}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Add ${row.transaction.description}`}
                    checked={row.include}
                    disabled={locked || (status === 'failed' && !acceptedFailure)}
                    onChange={() => onToggleRow(r)}
                  />
                </td>
                <td>{shortDay(row.transaction.postedDate)}</td>
                <td>{row.transaction.description}</td>
                <td class={`num ${amount !== null && amount > 0 ? 'money-in' : ''}`}>
                  {amount === null ? '?' : `${amount > 0 ? '+' : ''}${formatExact(amount)}`}
                </td>
                <td>
                  <span class={`chip chip-${row.status}`}>{STATUS_LABEL[row.status]}</span>
                  {row.reasons.length > 0 && <span class="row-reason">{row.reasons.join(' ')}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {s.unreadLines.length > 0 && <Diagnostics lines={diagnostics} />}
    </section>
  );
}
