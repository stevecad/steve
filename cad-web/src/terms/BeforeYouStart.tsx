/**
 * "Before you start": the page a person reads and agrees to before STEVE opens (app/terms.py). The words are the
 * server's, exactly as recorded. Someone who doesn't agree can download their data and delete the account here.
 */
import { useState } from 'react';
import { Button } from '@/ui';
import { signOut } from '@/auth/auth';
import { DeleteAccount, ExportData, pendingDeletion } from '@/settings/sections/AccountData';
import { acceptTerms, type Terms } from './terms';
import css from './BeforeYouStart.module.css';

export default function BeforeYouStart({ terms, onAccepted }: { terms: Terms; onAccepted: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(pendingDeletion);
  const [deleting, setDeleting] = useState(false);
  const { summary } = terms;

  const accept = async () => {
    setBusy(true); setError(null);
    try {
      await acceptTerms(terms.version);
      onAccepted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  return (
    <main id="before-you-start" className={css.page}>
      <div className={css.card}>
        <h1 className={css.title}>{summary.title}</h1>
        <p className={css.intro}>{summary.intro}</p>
        <ul className={css.points}>
          {summary.points.map((point) => (
            <li key={point.title}><b>{point.title}</b> {point.text}</li>
          ))}
        </ul>
        <p className={css.closing}>{summary.closing}</p>

        <label className={css.agree}>
          <input type="checkbox" id="terms-agree" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
          <span>
            I've read and agree to the <a href={terms.terms_url} target="_blank" rel="noreferrer">Terms of Service</a> and{' '}
            <a href={terms.privacy_url} target="_blank" rel="noreferrer">Privacy Policy</a>.
          </span>
        </label>
        {error && <p className={css.error} role="alert">{error}</p>}
        <div className={css.actions}>
          <Button variant="primary" id="terms-accept" disabled={!agreed || busy || deleting} onClick={() => void accept()}>Start using STEVE</Button>
        </div>

        <div className={css.leave}>
          {!leaving ? (
            <p>Don't agree? <button type="button" className={css.link} onClick={() => setLeaving(true)}>Download your data or delete your account</button>, or <button type="button" className={css.link} onClick={() => void signOut()}>sign out</button>.</p>
          ) : (
            <>
              <h2>Download my data</h2>
              <p>One zip with your designs and their history, uploads, conversations and settings.</p>
              <ExportData disabled={deleting} />
              <h2>Delete my account</h2>
              <p>Deletes your account and everything in it, for good. It can't be undone.</p>
              <DeleteAccount onDeleting={setDeleting} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
