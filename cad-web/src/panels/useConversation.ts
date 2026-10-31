import { useEffect, useRef, useState } from 'react';
import { Api, ApiError, type AssistantSettings, type Conversation } from '@/lib/api';
import { CONVERSATION_KEY as KEY, drafts, PROVIDER_KEY, store, stored, useSteve } from './steve';

export function useConversation() {
  const [chat, setChat] = useState<Conversation | null>(null);
  const [provider, updateProvider] = useState(stored(PROVIDER_KEY) || 'openai');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const ready = useRef(false);
  const action = useRef(false);
  // The remembered conversation that couldn't be loaded (a dropped connection, a server restart): sending must not
  // quietly start a new chat in its place, which would leave STEVE without anything said before.
  const unloaded = useRef<string | null>(null);
  // The unsent message of the open conversation is kept when this tab closes.
  const latest = useRef({ id: 'unsaved', message: '' });
  latest.current = { id: chat?.conversation_id || 'unsaved', message };

  const setProvider = (value: string) => {
    updateProvider(value);
    store(PROVIDER_KEY, value);
  };
  const remember = (value: Conversation) => {
    setChat(value);
    setProvider(value.provider);
    store(KEY, value.conversation_id);
  };

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    // History may have opened a conversation (or asked for a new chat) for this tab to show.
    const opening = useSteve.getState().opening;
    useSteve.setState({ opening: null });
    const id = opening && opening !== 'new' ? opening.conversation_id : stored(KEY);
    void (async () => {
      try {
        if (opening === 'new') {
          const value = await Api.createConversation(stored(PROVIDER_KEY) || 'openai');
          if (!cancelled) { remember(value); setMessage(drafts.get('unsaved') ?? ''); }
        } else if (opening) {
          remember(opening);
          setMessage(drafts.get(opening.conversation_id) ?? '');
        } else if (id) {
          const value = await Api.conversation(id);
          if (!cancelled) { remember(value); setMessage(drafts.get(id) ?? ''); }
        } else setMessage(drafts.get('unsaved') ?? '');
      } catch (caught) {
        if (!cancelled) {
          if (caught instanceof ApiError && caught.status === 404) {
            store(KEY, null);
          } else {
            if (id && !opening) unloaded.current = id;
            setError((caught as Error).message);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          // A question written elsewhere (Ask STEVE about these results) wins over the saved draft. It is
          // cleared once the composer shows it (below): a remount before then must still find it.
          const { prefill } = useSteve.getState();
          if (prefill) setMessage(prefill);
          ready.current = true;
        }
      }
    })();
    return () => { cancelled = true; mounted.current = false; ready.current = false; drafts.set(latest.current.id, latest.current.message); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // …and arrives straight away when the chat is already open.
  useEffect(() => useSteve.subscribe((state) => { if (state.prefill && ready.current) setMessage(state.prefill); }), []);
  useEffect(() => { if (message && message === useSteve.getState().prefill) useSteve.setState({ prefill: null }); }, [message]);

  // Reopening the panel or refreshing during a run must not lose its eventual answer.
  useEffect(() => {
    if (!chat?.busy || chat.active_run_id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await Api.conversation(chat.conversation_id);
        if (!cancelled) { setChat(value); setError(null); }
      } catch (caught) { if (!cancelled) setError((caught as Error).message); }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [chat?.conversation_id, chat?.busy, chat?.active_run_id]);

  const select = async (id?: string) => {
    if (action.current || loading || chat?.busy) return false;
    action.current = true; setLoading(true); setError(null);
    try {
      const value = id ? await Api.conversation(id) : await Api.createConversation(provider);
      if (!mounted.current) return false;
      drafts.set(chat?.conversation_id || 'unsaved', message);
      remember(value);
      setMessage(id ? drafts.get(id) || '' : '');
      return true;
    } catch (caught) { if (mounted.current) setError((caught as Error).message); return false; }
    finally { action.current = false; if (mounted.current) setLoading(false); }
  };

  const ensure = async () => {
    if (chat) return chat;
    if (unloaded.current) {
      try {
        const value = await Api.conversation(unloaded.current);
        unloaded.current = null;
        if (mounted.current) remember(value);
        return value;
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 404)) throw new Error("Couldn't load this chat. Check your connection and try again.");
        unloaded.current = null;
        store(KEY, null);
      }
    }
    const value = await Api.createConversation(provider);
    if (mounted.current) remember(value);
    return value;
  };

  const settings = async (value: AssistantSettings) => {
    if (action.current || loading || chat?.busy) return;
    action.current = true; setLoading(true); setError(null);
    try {
      const current = await ensure();
      const result = await Api.assistantSettings(current.conversation_id, value, current.settings_revision);
      if (mounted.current) setChat({ ...current, ...result });
    } catch (caught) { if (mounted.current) setError((caught as Error).message); }
    finally { action.current = false; if (mounted.current) setLoading(false); }
  };
  return { chat, setChat, provider, setProvider, message, setMessage, loading, error, setError, select, ensure, settings, mounted };
}
