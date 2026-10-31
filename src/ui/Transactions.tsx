/**
 * "Your transactions": every imported transaction in one list, with one
 * search box, three simple filters and a "ready to sort" toggle. Clicking a
 * transaction opens a side panel to pick its category, rename it or add a
 * note. Every change is applied at once and saved in the background.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatExact } from '../domain/money';
import type { Category, Id, Transaction } from '../domain/types';
import { newId } from '../import/ids';
import { isReadyToSort, looksRight, othersLike, setCategory, setName, setNote } from '../review/edits';
import type { LedgerDocument } from '../storage/ledger';
import { lookFor, shownCategory } from './categoryLook';
import type { SaveState } from './saveQueue';

const MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (month: string) => MONTH_FORMAT.format(new Date(`${month}-01T12:00:00Z`));
const dayLabel = (iso: string) => DAY_FORMAT.format(new Date(`${iso}T12:00:00Z`));
const signedAmount = (cents: number) => `${cents > 0 ? '+' : ''}${formatExact(cents)}`;

export interface Filters {
  search: string;
  month: string;
  categoryId: string;
  accountId: string;
  onlyToSort: boolean;
}
export const NO_FILTERS: Filters = { search: '', month: '', categoryId: '', accountId: '', onlyToSort: false };

/** Whether a transaction matches the search box: its name, the statement's text, its note, or its amount. */
export function matchesSearch(t: Transaction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = [t.merchant, t.originalDescription, t.note ?? ''].join(' ').toLowerCase();
  if (text.includes(q)) return true;
  const amount = q.replace(/[$,\s+-]/g, '');
  return /^\d+(\.\d{0,2})?$/.test(amount) && (Math.abs(t.amountCents) / 100).toFixed(2).startsWith(amount);
}

export function filterTransactions(ledger: LedgerDocument, filters: Filters): Transaction[] {
  return ledger.transactions
    .filter((t) => {
      if (filters.month && !t.postedDate.startsWith(filters.month)) return false;
      if (filters.accountId && t.accountId !== filters.accountId) return false;
      if (filters.categoryId && shownCategory(ledger.categories, t.classification.categoryId)?.id !== filters.categoryId) return false;
      if (filters.onlyToSort && !isReadyToSort(t)) return false;
      return matchesSearch(t, filters.search);
    })
    .sort((a, b) => b.postedDate.localeCompare(a.postedDate) || a.id.localeCompare(b.id));
}

function CategoryChip({ category, movement }: { category: Category | undefined; movement: boolean }) {
  const look = lookFor(category?.id);
  return (
    <span class={`category-chip${movement ? ' category-chip-quiet' : ''}`} style={{ '--hue': String(look.hue) }}>
      <span aria-hidden="true">{look.icon}</span> {movement ? 'Moved between your accounts' : (category?.name ?? 'Uncategorized')}
    </span>
  );
}

export function TransactionsScreen({
  ledger,
  saveState,
  onChange,
  onHome,
  onLock,
  initialFilters = NO_FILTERS,
}: {
  ledger: LedgerDocument;
  saveState: SaveState;
  onChange: (ledger: LedgerDocument) => void;
  onHome: () => void;
  onLock: () => void;
  initialFilters?: Filters;
}) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const shown = useMemo(() => filterTransactions(ledger, filters), [ledger, filters]);
  const toSort = useMemo(() => ledger.transactions.filter(isReadyToSort).length, [ledger]);
  const accounts = new Map(ledger.accounts.map((a) => [a.id, a]));
  const months = useMemo(
    () => [...new Set(ledger.transactions.map((t) => t.postedDate.slice(0, 7)))].sort().reverse(),
    [ledger],
  );
  const pickable = ledger.categories.filter((c) => !c.hidden);
  const selected = ledger.transactions.find((t) => t.id === selectedId) ?? null;
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  // Day headings over a list that is already newest first.
  const groups: { day: string; items: Transaction[] }[] = [];
  for (const t of shown) {
    const last = groups[groups.length - 1];
    if (last?.day === t.postedDate) last.items.push(t);
    else groups.push({ day: t.postedDate, items: [t] });
  }

  /** After a category is chosen while sorting, the next one waiting opens by itself. */
  const chooseCategory = (categoryId: Id, alsoOthers: boolean) => {
    if (!selected) return;
    const position = shown.findIndex((t) => t.id === selected.id);
    const { ledger: next } = setCategory(ledger, selected.id, categoryId, { now: new Date(), newId, alsoOthers });
    onChange(next);
    if (filters.onlyToSort) {
      const remaining = filterTransactions(next, filters);
      setSelectedId(remaining[Math.min(position, remaining.length - 1)]?.id ?? null);
    }
  };

  return (
    <main class="transactions-screen" data-screen="transactions">
      <header class="screen-header">
        <button type="button" class="secondary-button" onClick={onHome}>
          ← Home
        </button>
        <h2>Your transactions</h2>
        <span class={`save-status save-${saveState}`} role="status">
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : saveState === 'error' ? "Couldn't save — will try again" : ''}
        </span>
        <button type="button" class="lock-button" onClick={onLock}>
          <span aria-hidden="true">🔒</span> Lock
        </button>
      </header>

      <section class="filters" aria-label="Find transactions">
        <label class="search">
          <input
            type="search"
            aria-label="Search"
            placeholder="Search names or amounts"
            value={filters.search}
            onInput={(e) => set({ search: e.currentTarget.value })}
          />
        </label>
        <label>
          <select aria-label="Month" value={filters.month} onChange={(e) => set({ month: e.currentTarget.value })}>
            <option value="">All months</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <select aria-label="Category" value={filters.categoryId} onChange={(e) => set({ categoryId: e.currentTarget.value })}>
            <option value="">All categories</option>
            {pickable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === 'income' && c.id === 'inc.uncategorized' ? 'Uncategorized money in' : c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <select aria-label="Account" value={filters.accountId} onChange={(e) => set({ accountId: e.currentTarget.value })}>
            <option value="">All accounts</option>
            {ledger.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          class={`toggle-chip${filters.onlyToSort ? ' toggle-chip-on' : ''}`}
          aria-pressed={filters.onlyToSort}
          onClick={() => set({ onlyToSort: !filters.onlyToSort })}
        >
          Only ready to sort <span class="count-badge">{toSort}</span>
        </button>
      </section>

      <div class={`transactions-body${selected ? ' with-panel' : ''}`}>
        <section class="transaction-list" aria-label="Transactions">
          {shown.length === 0 &&
            (filters.onlyToSort && toSort === 0 ? (
              <p class="empty-state">
                <span aria-hidden="true">⚾</span> All sorted — nice work!
              </p>
            ) : (
              <p class="empty-state">Nothing matches. Try a different search or filter.</p>
            ))}
          {groups.map((group) => (
            <div class="day-group" key={group.day}>
              <h3 class="day-heading">{dayLabel(group.day)}</h3>
              <ul>
                {group.items.map((t) => {
                  const movement = t.kind === 'transfer' || t.kind === 'card_payment';
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        class={`transaction-row${t.id === selectedId ? ' selected' : ''}${movement ? ' movement' : ''}`}
                        data-transaction-id={t.id}
                        onClick={() => setSelectedId(t.id)}
                      >
                        <span class="row-name">
                          {t.merchant}
                          <span class="row-account">{accounts.get(t.accountId)?.displayName}</span>
                        </span>
                        <CategoryChip category={shownCategory(ledger.categories, t.classification.categoryId)} movement={movement} />
                        {isReadyToSort(t) && <span class="sort-dot" title="Ready to sort" aria-label="Ready to sort" />}
                        <span class={`row-amount${t.amountCents > 0 ? ' money-in' : ''}`}>{signedAmount(t.amountCents)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>

        {selected && (
          <DetailPanel
            key={selected.id}
            ledger={ledger}
            transaction={selected}
            categories={pickable}
            accountName={accounts.get(selected.accountId)?.displayName ?? ''}
            onClose={() => setSelectedId(null)}
            onChooseCategory={chooseCategory}
            onChange={onChange}
          />
        )}
      </div>
    </main>
  );
}

function DetailPanel({
  ledger,
  transaction: t,
  categories,
  accountName,
  onClose,
  onChooseCategory,
  onChange,
}: {
  ledger: LedgerDocument;
  transaction: Transaction;
  categories: Category[];
  accountName: string;
  onClose: () => void;
  onChooseCategory: (categoryId: Id, alsoOthers: boolean) => void;
  onChange: (ledger: LedgerDocument) => void;
}) {
  const [alsoOthers, setAlsoOthers] = useState(false);
  const [name, setNameInput] = useState(t.merchant);
  const [note, setNoteInput] = useState(t.note ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const others = othersLike(ledger, t.id).length;
  const current = shownCategory(ledger.categories, t.classification.categoryId);
  const movement = t.kind === 'transfer' || t.kind === 'card_payment';

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = (category: Category) => {
    const wasMovement = movement;
    onChooseCategory(category.id, alsoOthers && others > 0);
    if (wasMovement && category.kind !== 'transfer') setMessage(`This now counts as ${category.kind === 'income' ? 'money in' : 'spending'}.`);
    else if (!wasMovement && category.kind === 'transfer') setMessage("This no longer counts as spending or money in.");
    else setMessage(null);
  };

  const section = (title: string, list: Category[]) => (
    <div class="category-section">
      <h4>{title}</h4>
      <div class="category-grid">
        {list.map((c) => {
          const look = lookFor(c.id);
          const active = current?.id === c.id;
          return (
            <button
              type="button"
              key={c.id}
              class={`category-button${active ? ' active' : ''}`}
              style={{ '--hue': String(look.hue) }}
              aria-pressed={active}
              onClick={() => choose(c)}
            >
              <span class="category-icon" aria-hidden="true">
                {look.icon}
              </span>
              {c.name}
            </button>
          );
        })}
      </div>
    </div>
  );

  const flagged = t.needsReview && current && !current.id.endsWith('uncategorized');

  return (
    <aside class="detail-panel" aria-label="Transaction details" tabIndex={-1} ref={panel}>
      <button type="button" class="close-button" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <p class={`detail-amount${t.amountCents > 0 ? ' money-in' : ''}`}>{signedAmount(t.amountCents)}</p>
      <p class="detail-meta">
        {dayLabel(t.postedDate)} · {accountName}
      </p>

      <label class="detail-field">
        Name
        <input
          value={name}
          onInput={(e) => {
            const value = e.currentTarget.value;
            setNameInput(value);
            if (value.trim() && value.trim() !== t.merchant) onChange(setName(ledger, t.id, value));
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      <p class="original-text">
        From your statement: <code>{t.originalDescription}</code>
      </p>

      {flagged && (
        <div class="check-this">
          <p>
            <strong>Is {current!.name} right?</strong> {t.classification.reasons[0] ?? ''}
          </p>
          <button type="button" class="primary-button" onClick={() => onChange(looksRight(ledger, t.id))}>
            Looks right
          </button>
        </div>
      )}

      {others > 0 && (
        <label class="checkbox also-others">
          <input type="checkbox" checked={alsoOthers} onChange={(e) => setAlsoOthers(e.currentTarget.checked)} />
          Also use my choice for the {others} other "{t.merchant}" {others === 1 ? 'transaction' : 'transactions'}, and
          future ones
        </label>
      )}

      {t.amountCents < 0 ? (
        <>
          {section('Spending', categories.filter((c) => c.kind === 'expense'))}
          {section('Money in', categories.filter((c) => c.kind === 'income'))}
        </>
      ) : (
        <>
          {section('Money in', categories.filter((c) => c.kind === 'income'))}
          {section('Spending (a refund or return)', categories.filter((c) => c.kind === 'expense'))}
        </>
      )}
      {section('Moved between your accounts', categories.filter((c) => c.kind === 'transfer'))}
      {message && (
        <p class="hint" role="status">
          {message}
        </p>
      )}

      <label class="detail-field">
        Note
        <textarea
          rows={2}
          value={note}
          placeholder="Add a note (optional)"
          onInput={(e) => {
            const value = e.currentTarget.value;
            setNoteInput(value);
            if (value.trim() !== (t.note ?? '')) onChange(setNote(ledger, t.id, value));
          }}
        />
      </label>
    </aside>
  );
}
