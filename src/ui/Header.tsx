import type { ComponentChildren } from 'preact';

export function Header({ children }: { children?: ComponentChildren }) {
  return (
    <header class="landing-header">
      <span class="logo" aria-hidden="true">
        🏡
      </span>
      <h1>Our Household Money</h1>
      <p class="tagline">See where your money comes from and where it goes.</p>
      {children}
    </header>
  );
}
