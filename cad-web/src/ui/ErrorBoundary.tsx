import { Component, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { isStaleChunk, reloadApp, reloadForStaleChunk } from '@/state/updateWatch';

interface State { error: Error | null }

/** Keeps a failure in one panel from blanking the whole workspace. */
export default class ErrorBoundary extends Component<{ name: string; children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error) {
    console.error(`${this.props.name} failed`, error);
    if (isStaleChunk(error)) reloadForStaleChunk();  // A lazy panel from before a deploy: get the new build.
  }

  render() {
    if (!this.state.error) return this.props.children;
    // A lazy panel's rejected import is cached, so "Try again" can't load it; only the new build can.
    const stale = isStaleChunk(this.state.error);
    return (
      <div role="alert" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height: '100%', padding: 24, textAlign: 'center', color: 'var(--text-2)', fontSize: 12 }}>
        <TriangleAlert size={22} color="var(--warning)" />
        <b style={{ color: 'var(--text-1)', fontSize: 13 }}>{stale ? 'STEVE Studio has been updated' : `${this.props.name} hit a problem`}</b>
        <span style={{ maxWidth: 280, color: 'var(--text-3)' }}>{stale ? 'Reload to get the latest version. Unsaved edits are kept.' : this.state.error.message}</span>
        <button type="button" onClick={() => stale ? reloadApp() : this.setState({ error: null })} style={{ marginTop: 4, padding: '6px 12px', borderRadius: 6, background: 'var(--bg-4)', border: '1px solid var(--line-3)', color: 'var(--text-1)' }}>{stale ? 'Reload' : 'Try again'}</button>
      </div>
    );
  }
}
