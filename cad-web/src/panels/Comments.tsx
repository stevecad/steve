/**
 * Comments (comments/comments.ts): notes pinned to the selected faces, edges, corners or components, for the person's
 * AI agent to read over MCP, reply to and resolve. Write about the current selection at the top; threads below,
 * numbered like their pins in the viewport.
 */
import { useState } from 'react';
import { Bot, Check, GitBranch, MessageSquareText, RotateCcw, Sparkles, Trash2, User } from 'lucide-react';
import { Button, IconButton, Spinner, Switch, ui } from '@/ui';
import { useApp } from '@/state/store';
import { switchBranch } from '@/state/actions';
import { whoLabel } from '@/teams/attribution';
import { useWorkspace } from '@/teams/current';
import { relativeTime } from '@/lib/format';
import { viewer } from '@/viewport/viewer';
import { addComment, deleteComment, replyTo, selectionAnchor, setThreadStatus, useComments, type CommentItem, type Thread } from '@/comments/comments';
import * as THREE from 'three';
import panels from './Panels.module.css';
import styles from './Comments.module.css';

/** Zooms to a comment's pin (a box around it, a fifth of the model's size). */
function showPoint(point: [number, number, number]) {
  const half = Math.max(viewer.modelRadius() * 0.2, 1);
  const center = new THREE.Vector3(...point);
  viewer.zoomTo(new THREE.Box3(center.clone().subScalar(half), center.clone().addScalar(half)));
}

function Composer() {
  const count = useApp((state) => state.selection.length);
  const [text, setText] = useState('');
  const [forAgents, setForAgents] = useState(false);
  // In a team, a viewer's comments are for people only (the server ignores For AI from a viewer, app/comments.py).
  const viewing = useWorkspace((state) => state.team?.role === 'viewer');
  const [sending, setSending] = useState(false);
  const mentions = /(^|[^\w@])@(ai|agent|agents|steve)\b/i.test(text);   // the server marks these for agents too
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    if (await addComment(text.trim(), selectionAnchor(), forAgents)) { setText(''); setForAgents(false); }
    setSending(false);
  };
  return (
    <div className={styles.composer}>
      <textarea id="comment-new" className={`${ui.input} ${styles.text}`} rows={3} value={text} maxLength={4000} onChange={(event) => setText(event.target.value)}
        placeholder={count ? `What should change about the ${count === 1 ? 'selected item' : `${count} selected items`}?` : 'Select faces, edges or corners, then describe what should change.'}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(); }} />
      <div className={styles.composerRow}>
        <span className={styles.hint}>{count ? `Pinned to ${count === 1 ? 'the selection' : `${Math.min(count, 12)} selected items`}` : 'Not pinned: nothing selected'}</span>
        {!viewing && <span className={styles.forAiToggle} id="comment-for-ai" title="AI agents list the comments addressed to them and work on them (mentioning @ai does the same)">
          <Switch checked={forAgents || mentions} disabled={mentions} onCheckedChange={setForAgents} label="For AI" /> For AI
        </span>}
        <Button size="sm" variant="primary" id="comment-send" disabled={!text.trim() || sending} onClick={() => void send()}>{sending ? 'Adding…' : 'Comment'}</Button>
      </div>
    </div>
  );
}

function Item({ item, onDelete }: { item: CommentItem; onDelete?: () => void }) {
  const Author = item.author === 'agent' ? Bot : User;
  const by = whoLabel(item.who) || (item.author === 'agent' ? 'AI agent' : 'You');
  return (
    <div className={styles.item} data-author={item.author}>
      <div className={styles.meta}>
        <Author size={12} /> <span data-comment-by>{by}</span> · <span>{relativeTime(item.created_at)}</span>
        {onDelete && item.author === 'person' && <IconButton small label="Delete" className={styles.delete} onClick={onDelete}><Trash2 /></IconButton>}
      </div>
      <p className={styles.body}>{item.body}</p>
    </div>
  );
}

/** "Resolved by Alice via Claude (MCP) on branch wider": the branch opens (a member reviews and merges it there). */
function Resolved({ thread }: { thread: Thread }) {
  const branches = useApp((state) => state.branches);
  const current = useApp((state) => state.doc.branch);
  const resolution = thread.resolution;
  const by = whoLabel(resolution?.by) || (thread.resolved_by === 'agent' ? 'the AI agent' : '');
  const branch = resolution?.branch;
  const live = !!branch && branch !== current && !!branches?.some((item) => item.name === branch);
  return (
    <div className={styles.note} data-resolved>
      Resolved{by ? ` by ${by}` : ''}
      {branch && <> on branch {live
        ? <button type="button" className={styles.branchLink} onClick={(event) => { event.stopPropagation(); switchBranch(branch); }}><GitBranch size={11} /> {branch}</button>
        : <b>{branch}</b>}</>}
      {resolution?.revision ? ` (r${resolution.revision})` : ''}.
    </div>
  );
}

function ThreadCard({ thread }: { thread: Thread }) {
  const focus = useComments((state) => state.focus);
  const revision = useApp((state) => state.doc.saved?.revision);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!reply.trim() || busy) return;
    setBusy(true);
    if (await replyTo(thread, reply.trim())) setReply('');
    setBusy(false);
  };
  const where = thread.anchor.map((a) => a.description.split(' on ')[0]).filter(Boolean);
  const point = thread.anchor.find((a) => a.point)?.point;
  return (
    <li className={styles.thread} data-status={thread.status} data-focus={focus === thread.id || undefined} data-comment={thread.number}
      onClick={() => useComments.setState({ focus: thread.id })}>
      <div className={styles.head}>
        <span className={styles.number}>{thread.number}</span>
        <button type="button" className={styles.where} disabled={!point} title={point ? 'Show it in the viewport' : 'Not pinned to geometry'}
          onClick={(event) => { event.stopPropagation(); useComments.setState({ focus: thread.id }); if (point) showPoint(point); }}>
          {where.length ? where.join(' · ') : 'General comment'}
        </button>
        {thread.for_agents && <span className={styles.forAi} title="Addressed to AI agents: they list these to work on" data-for-ai><Sparkles size={11} /> For AI</span>}
        {thread.status === 'open'
          ? <IconButton small label="Resolve" onClick={(event) => { event.stopPropagation(); void setThreadStatus(thread, 'resolved'); }}><Check /></IconButton>
          : <IconButton small label="Reopen" onClick={(event) => { event.stopPropagation(); void setThreadStatus(thread, 'open'); }}><RotateCcw /></IconButton>}
      </div>
      {thread.revision && revision && thread.revision < revision && (
        <div className={styles.note}>Written on revision {thread.revision}; the design has changed since.</div>
      )}
      <Item item={thread} onDelete={() => void deleteComment(thread)} />
      {thread.replies.map((item) => <Item key={item.id} item={item} onDelete={() => void deleteComment(item)} />)}
      {thread.status === 'resolved' && <Resolved thread={thread} />}
      {thread.status === 'open' && (
        <div className={styles.replyRow} onClick={(event) => event.stopPropagation()}>
          <input className={ui.input} value={reply} maxLength={4000} placeholder="Reply…" aria-label={`Reply to comment ${thread.number}`}
            onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void send(); }} />
          <Button size="sm" disabled={!reply.trim() || busy} onClick={() => void send()}>Reply</Button>
        </div>
      )}
    </li>
  );
}

export default function Comments() {
  const open = useApp((state) => state.doc.open && !!state.doc.saved);
  const { threads, loading, error, showResolved } = useComments();
  if (!open) {
    return (
      <div className={panels.empty}>
        <MessageSquareText size={22} />
        <h3>Comments</h3>
        <p>Save the design to pin comments to its faces, edges and corners for your AI agent.</p>
      </div>
    );
  }
  const shown = threads.filter((thread) => showResolved || thread.status === 'open');
  const resolved = threads.filter((thread) => thread.status === 'resolved').length;
  return (
    <div className={styles.panel}>
      <Composer />
      <div className={styles.bar}>
        <span>{threads.length - resolved} open{resolved ? ` · ${resolved} resolved` : ''}</span>
        {resolved > 0 && <Switch checked={showResolved} onCheckedChange={(value) => useComments.setState({ showResolved: value })} label="Show resolved" />}
      </div>
      <div className={panels.scroll}>
        {error ? <p className={styles.error} role="alert">{error}</p>
          : loading && !threads.length ? <div className={styles.loading}><Spinner size={16} /></div>
          : !shown.length ? (
            <div className={styles.emptyList} id="comments-empty">
              <p>No {resolved ? 'open ' : ''}comments. Select what needs work, write what should change, and ask your AI agent (over MCP) to work through your comments.</p>
            </div>
          ) : <ul className={styles.list} id="comments-list">{shown.map((thread) => <ThreadCard key={thread.id} thread={thread} />)}</ul>}
      </div>
    </div>
  );
}
