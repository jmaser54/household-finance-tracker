import type { ComponentChildren } from 'preact';
import { DashboardPreview } from './DashboardPreview';
import { BackupCard } from './Backup';
import { Header } from './Header';

export function Landing({
  onLock,
  notices,
  backups,
}: {
  onLock: () => void;
  notices?: ComponentChildren;
  backups: Parameters<typeof BackupCard>[0];
}) {
  return (
    <main class="landing">
      <Header>
        {notices}
        <button type="button" class="lock-button" onClick={onLock}>
          <span aria-hidden="true">🔒</span> Lock
        </button>
      </Header>

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
          <span aria-hidden="true">🔒</span> Statements will be read on this Mac and saved here, encrypted with your
          passphrase. Nothing is uploaded.
        </p>
      </section>

      <DashboardPreview />

      <BackupCard {...backups} />
    </main>
  );
}
