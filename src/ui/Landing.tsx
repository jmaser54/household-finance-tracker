import { DashboardPreview } from './DashboardPreview';

export function Landing() {
  return (
    <main class="landing">
      <header class="landing-header">
        <span class="logo" aria-hidden="true">
          🏡
        </span>
        <h1>Our Household Money</h1>
        <p class="tagline">See where your money comes from and where it goes.</p>
      </header>

      <section class="upload-card" aria-labelledby="upload-heading" data-dropzone>
        <h2 id="upload-heading">Add your statements</h2>
        <p>Drop PDF statements from your checking, savings, and credit card accounts.</p>
        <div class="dropzone" aria-disabled="true">
          <span class="dropzone-icon" aria-hidden="true">
            📄
          </span>
          <span>Statement import is being built and is not available yet.</span>
        </div>
        <p class="privacy-note">
          <span aria-hidden="true">🔒</span> Statements are read on this computer and stay in this browser. Nothing is
          uploaded.
        </p>
      </section>

      <DashboardPreview />
    </main>
  );
}
