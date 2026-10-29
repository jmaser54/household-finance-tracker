import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { DashboardPreview } from './DashboardPreview';
import { BackupCard } from './Backup';
import { Header } from './Header';

export function Landing({
  onLock,
  notices,
  backups,
  onStatements,
}: {
  onLock: () => void;
  notices?: ComponentChildren;
  backups: Parameters<typeof BackupCard>[0];
  onStatements: (files: File[]) => void;
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

      <section class="upload-card" aria-labelledby="upload-heading" data-dropzone>
        <h2 id="upload-heading">Add your statements</h2>
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

      <DashboardPreview />

      <BackupCard {...backups} />
    </main>
  );
}
