import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { DashboardPreview } from './DashboardPreview';
import { BackupCard } from './Backup';
import { Header } from './Header';

/** What the household has so far, for the "Your money" card. */
export interface MoneySoFar {
  transactions: number;
  statements: number;
  toSort: number;
}

export function Landing({
  onLock,
  notices,
  backups,
  onStatements,
  money,
  onTransactions,
}: {
  onLock: () => void;
  notices?: ComponentChildren;
  backups: Parameters<typeof BackupCard>[0];
  onStatements: (files: File[]) => void;
  money: MoneySoFar;
  onTransactions: (onlyToSort: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const accept = (list: FileList | null | undefined) => {
    const files = [...(list ?? [])];
    if (files.length) onStatements(files);
  };
  return (
    <main class="landing">
      <Header>
        {notices}
        <button type="button" class="lock-button" onClick={onLock}>
          <span aria-hidden="true">🔒</span> Lock
        </button>
      </Header>

      {money.transactions > 0 && (
        <section class="money-card" aria-labelledby="money-heading">
          <h2 id="money-heading">Your money</h2>
          <div class="scoreboard">
            <div class="score">
              <span class="score-number">{money.transactions}</span>
              <span class="score-label">
                {money.transactions === 1 ? 'transaction' : 'transactions'} from {money.statements}{' '}
                {money.statements === 1 ? 'statement' : 'statements'}
              </span>
            </div>
            <div class={`score${money.toSort ? ' score-highlight' : ''}`}>
              <span class="score-number">{money.toSort}</span>
              <span class="score-label">ready to sort</span>
            </div>
          </div>
          <div class="button-row">
            <button type="button" class="primary-button" onClick={() => onTransactions(false)}>
              See your transactions
            </button>
            {money.toSort > 0 && (
              <button type="button" class="secondary-button" onClick={() => onTransactions(true)}>
                Sort {money.toSort === 1 ? 'it' : 'them'} now
              </button>
            )}
          </div>
        </section>
      )}

      <section class={`upload-card${money.transactions > 0 ? ' upload-card-compact' : ''}`} aria-labelledby="upload-heading" data-dropzone>
        <h2 id="upload-heading">{money.transactions > 0 ? 'Add more statements' : 'Add your statements'}</h2>
        <p>Drop PDF statements from your checking, savings, and credit card accounts.</p>
        <div
          class={dragging ? 'dropzone dropzone-active' : 'dropzone'}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            accept(e.dataTransfer?.files);
          }}
        >
          <span class="dropzone-icon" aria-hidden="true">
            📄
          </span>
          <span>Drop statement PDFs here, or</span>
          <button type="button" class="primary-button" onClick={() => input.current?.click()}>
            Choose statement PDFs…
          </button>
          <input
            ref={input}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            data-testid="statement-input"
            onChange={(e) => {
              accept(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <span class="hint">You can add several months at once. You'll check everything before it's added.</span>
        </div>
        <p class="privacy-note">
          <span aria-hidden="true">🔒</span> Statements are read on this Mac. Only the transactions you confirm are
          saved, encrypted with your passphrase. The PDFs themselves aren't kept, and nothing is uploaded.
        </p>
      </section>

      {money.transactions === 0 && <DashboardPreview />}

      <BackupCard {...backups} />
    </main>
  );
}
