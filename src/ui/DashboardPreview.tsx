import { formatRounded } from '../domain/money';

/** Made-up numbers that only illustrate the layout. Not derived from any real data. */
const EXAMPLE = {
  monthLabel: 'Example month',
  incomeCents: 812_000,
  spendingCents: 688_000,
  topSpending: [
    { name: 'Housing', cents: 245_000 },
    { name: 'Childcare & School', cents: 132_000 },
    { name: 'Groceries', cents: 98_000 },
    { name: 'Dining & Takeout', cents: 41_000 },
    { name: 'Transportation', cents: 37_000 },
  ],
};

export function DashboardPreview() {
  const net = EXAMPLE.incomeCents - EXAMPLE.spendingCents;
  const largest = Math.max(...EXAMPLE.topSpending.map((c) => c.cents));

  return (
    <section class="preview" aria-labelledby="preview-heading">
      <div class="preview-badge">Example with made-up numbers</div>
      <h2 id="preview-heading" class="visually-hidden">
        Example of the household dashboard
      </h2>

      <div class="preview-hero">
        <span class="preview-label">{EXAMPLE.monthLabel}: you kept</span>
        <span class="preview-hero-number">{formatRounded(net)}</span>
      </div>

      <div class="preview-tiles">
        <div class="tile tile-in">
          <span class="tile-label">Came in</span>
          <span class="tile-value">{formatRounded(EXAMPLE.incomeCents)}</span>
        </div>
        <div class="tile tile-out">
          <span class="tile-label">Went out</span>
          <span class="tile-value">{formatRounded(EXAMPLE.spendingCents)}</span>
        </div>
      </div>

      <h3 class="preview-subhead">Where it went</h3>
      <ul class="bars">
        {EXAMPLE.topSpending.map((category) => (
          <li key={category.name} class="bar-row">
            <span class="bar-name">{category.name}</span>
            <span class="bar-track" aria-hidden="true">
              <span class="bar-fill" style={{ width: `${(category.cents / largest) * 100}%` }} />
            </span>
            <span class="bar-value">{formatRounded(category.cents)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
