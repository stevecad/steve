import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Api, type AssistantRun, type ChatTurn, type Conversation, type QueuedMessage } from '@/lib/api';

interface Activity { call_id: string; name: string; status: string; agent: string; skill?: string }
/** What the live run shows, in arrival order: STEVE's streamed text, and messages delivered while it worked. */
export type LiveItem = { kind: 'text'; key: string; text: string } | { kind: 'steer'; key: string; message: QueuedMessage };

const TERMINAL = new Set(['succeeded', 'failed', 'stopped']);

export function useAssistantRun(chat: Conversation | null, setChat: Dispatch<SetStateAction<Conversation | null>>,
  setError: Dispatch<SetStateAction<string | null>>, onDone: (reply: ChatTurn) => void) {
  const [run, setRun] = useState<AssistantRun | null>(null);
  const [timeline, setTimeline] = useState<LiveItem[]>([]);
  const [activity, setActivity] = useState<Record<string, Activity>>({});
  const [reconnecting, setReconnecting] = useState(false);
  // Whether STEVE's latest output was prose (it is writing) or a tool call.
  const [writing, setWriting] = useState(false);
  const callback = useRef(onDone);
  callback.current = onDone;
  const id = chat?.active_run_id;
  useEffect(() => {
    setRun(null); setTimeline([]); setActivity({}); setReconnecting(false); setWriting(false);
    if (!id) return;
    let cancelled = false, finishing = false;
    let stream: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const finish = async () => {
      if (finishing || cancelled) return;
      finishing = true;
      try {
        const status = await Api.assistantRun(id);
        if (!TERMINAL.has(status.status)) { finishing = false; return; }
        const value = await Api.conversation(status.conversation_id);
        if (cancelled) return;
        setChat((current) => current?.conversation_id === value.conversation_id ? value : current);
        if (status.error) setError(status.error);
        if (status.result && status.status === 'succeeded') callback.current(status.result);
        stream?.close();
      } catch {
        finishing = false;
        if (!cancelled) { setReconnecting(true); retry = setTimeout(() => void finish(), 1500); }
      }
    };
    const connect = async () => {
      try {
        const current = await Api.assistantRun(id);
        if (cancelled) return;
        setRun(current); setReconnecting(false);
        if (TERMINAL.has(current.status)) { void finish(); return; }
        stream = new EventSource(current.events_url);
        stream.onopen = () => setReconnecting(false);
        stream.onerror = () => { if (!cancelled) setReconnecting(true); };
        stream.addEventListener('status', (event) => {
          const value = JSON.parse((event as MessageEvent).data);
          setRun((old) => !old ? old : value.status === 'stopping' ? { ...old, stop_requested: true } : { ...old, status: value.status });
        });
        stream.addEventListener('text', (event) => {
          const value = JSON.parse((event as MessageEvent).data);
          // Reviewer prose is represented by its tool activity; only STEVE's text is the reply.
          if (value.agent?.endsWith('_reviewer')) return;
          setWriting(true);
          setTimeline((old) => old.some((item) => item.key === value.segment)
            ? old.map((item) => (item.key === value.segment ? { kind: 'text', key: item.key, text: value.text } : item))
            : [...old, { kind: 'text', key: value.segment, text: value.text }]);
        });
        stream.addEventListener('steer', (event) => {
          const message: QueuedMessage = JSON.parse((event as MessageEvent).data);
          setTimeline((old) => old.some((item) => item.key === message.id) ? old : [...old, { kind: 'steer', key: message.id, message }]);
        });
        stream.addEventListener('queue', (event) => {
          const value = JSON.parse((event as MessageEvent).data);
          setChat((old) => old?.active_run_id === id ? { ...old, queued: value.items } : old);
        });
        stream.addEventListener('tool', (event) => {
          const value: Activity = JSON.parse((event as MessageEvent).data);
          setActivity((old) => ({ ...old, [value.agent + ':' + value.call_id]: value }));
          if (value.status === 'started') setWriting(false);
        });
        stream.addEventListener('plan', (event) => {
          const value = JSON.parse((event as MessageEvent).data);
          setChat((old) => old?.active_run_id === id ? { ...old, plan: value.items } : old);
        });
        for (const name of ['done', 'failed', 'stopped', 'end']) stream.addEventListener(name, () => void finish());
      } catch {
        if (!cancelled) { setReconnecting(true); retry = setTimeout(() => void connect(), 1500); }
      }
    };
    void connect();
    return () => { cancelled = true; clearTimeout(retry); stream?.close(); };
  }, [id, setChat, setError]);
  const text = timeline.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('\n\n');
  return { run, text, timeline, activity: Object.values(activity), reconnecting, writing };
}
