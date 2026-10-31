/** A small "copy this message" button for errors people paste into a bug report or to STEVE. Works over plain HTTP. */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '@/lib/clipboard';

export default function CopyMessage({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  return (
    <button type="button" className={className} data-copy-message aria-label={copied ? 'Copied' : 'Copy message'} title={copied ? 'Copied' : 'Copy message'}
      onClick={() => void copy()} style={{ display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: 6, color: 'inherit', opacity: 0.8, flexShrink: 0 }}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
