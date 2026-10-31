import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { AlertCircle, X } from 'lucide-react';
import { Spinner } from '@/ui';
import { Api, attachmentUrl, type Attachment, type AttachmentMeta } from '@/lib/api';
import styles from './Assistant.module.css';

export const MAX_IMAGES = 4;
const MAX_EDGE = 1568; // What vision models work at; larger images only cost tokens.
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** Downsizes a picture to the model's working size and re-encodes it; small ones pass through. */
export async function prepareImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000 && ACCEPTED.includes(file.type) && file.type !== 'image/gif') return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const webp = await toBlob(canvas, 'image/webp', 0.9);
    if (webp?.type === 'image/webp') return webp;
    const fallback = await toBlob(canvas, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9);
    if (!fallback) throw new Error('This browser couldn’t encode the image.');
    return fallback;
  } finally { bitmap.close(); }
}

export const isImage = (file: { type: string }) => file.type.startsWith('image/');

/** The 3D view as the user sees it: the transparent WebGL frame over the viewport's backdrop. */
export async function viewSnapshot(frame: string): Promise<Blob> {
  const image = new Image();
  image.src = frame;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d')!;
  const css = getComputedStyle(document.documentElement);
  const backdrop = context.createLinearGradient(0, 0, 0, canvas.height);
  backdrop.addColorStop(0, css.getPropertyValue('--vp-top').trim() || '#2a3136');
  backdrop.addColorStop(1, css.getPropertyValue('--vp-bottom').trim() || '#0f1214');
  context.fillStyle = backdrop;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  const blob = await toBlob(canvas, 'image/png');
  if (!blob) throw new Error('Couldn’t capture the view.');
  return blob;
}

export interface DraftImage {
  key: string;
  name: string;
  preview: string;
  status: 'uploading' | 'ready' | 'failed';
  attachment?: Attachment;
  error?: string;
}

let sequence = 0;

/** Already-uploaded images as tray drafts (e.g. a queued message returned by Stop). */
export const draftsFrom = (images: AttachmentMeta[]): DraftImage[] => images.map((image) => ({
  key: `img-${++sequence}`, name: image.name, preview: attachmentUrl(image.id, true), status: 'ready',
  attachment: { ...image, size: 0, url: attachmentUrl(image.id), thumbnail_url: attachmentUrl(image.id, true) },
}));

/** Images waiting to go with the next message: prepared, uploaded and previewed as they are added. */
export function useDraftImages(onError: (message: string) => void) {
  const [drafts, setDrafts] = useState<DraftImage[]>([]);
  const live = useRef(drafts);
  live.current = drafts;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; live.current.forEach((item) => URL.revokeObjectURL(item.preview)); }, []);
  const patch = (key: string, fields: Partial<DraftImage>) => { if (alive.current) setDrafts((list) => list.map((item) => (item.key === key ? { ...item, ...fields } : item))); };

  const add = useCallback((files: { blob: Blob; name: string }[]) => {
    const images = files.filter(({ blob }) => isImage(blob));
    if (!images.length) { if (files.length) onError('STEVE can look at PNG, JPEG, WebP or GIF images.'); return; }
    const room = MAX_IMAGES - live.current.length;
    if (room <= 0) { onError(`Up to ${MAX_IMAGES} images per message.`); return; }
    if (images.length > room) onError(`Up to ${MAX_IMAGES} images per message; added the first ${room}.`);
    for (const { blob, name } of images.slice(0, room)) {
      const key = `img-${++sequence}`;
      const draft: DraftImage = { key, name, preview: URL.createObjectURL(blob), status: 'uploading' };
      live.current = [...live.current, draft];
      setDrafts((list) => [...list, draft]);
      void (async () => {
        try {
          const prepared = await prepareImage(blob);
          const attachment = await Api.uploadAttachment(prepared, name);
          patch(key, { status: 'ready', attachment });
        } catch (error) {
          patch(key, { status: 'failed', error: (error as Error).message || 'Upload failed.' });
        }
      })();
    }
  }, [onError]);

  const remove = useCallback((key: string) => {
    setDrafts((list) => list.filter((item) => { if (item.key === key) URL.revokeObjectURL(item.preview); return item.key !== key; }));
  }, []);

  /** Hands over the uploaded images for sending and empties the tray. */
  const take = useCallback((): { taken: DraftImage[]; attachments: AttachmentMeta[] } => {
    const taken = live.current;
    setDrafts([]);
    live.current = [];
    return { taken, attachments: taken.flatMap((item) => (item.attachment ? [item.attachment] : [])) };
  }, []);

  /** Puts images back after a send that didn't go through. */
  const restore = useCallback((items: DraftImage[]) => { if (alive.current) setDrafts((list) => [...items, ...list].slice(0, MAX_IMAGES)); }, []);

  return { drafts, add, remove, take, restore, uploading: drafts.some((item) => item.status === 'uploading'), ready: drafts.filter((item) => item.status === 'ready') };
}

/** The images about to be sent, above the message field. */
export function DraftTray({ drafts, onRemove }: { drafts: DraftImage[]; onRemove: (key: string) => void }) {
  return (
    <AnimatePresence initial={false}>
      {drafts.length > 0 && (
        <motion.div className={styles.tray} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}>
          <div className={styles.trayInner}>
            <AnimatePresence initial={false}>
              {drafts.map((item) => (
                <motion.figure key={item.key} className={styles.draft} data-status={item.status} layout
                  initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.12 } }}
                  transition={{ type: 'spring', stiffness: 520, damping: 34 }} title={item.error ?? item.name}>
                  <img src={item.preview} alt={item.name || 'Attached image'} />
                  {item.status === 'uploading' && <span className={styles.draftState}><Spinner size={14} /></span>}
                  {item.status === 'failed' && <span className={styles.draftState} data-failed><AlertCircle size={15} /></span>}
                  <button type="button" className={styles.draftRemove} aria-label={`Remove ${item.name || 'image'}`} onClick={() => onRemove(item.key)}><X size={11} strokeWidth={2.4} /></button>
                </motion.figure>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Images on a sent message; a click opens them full size. */
export function MessageImages({ images, onOpen }: { images: AttachmentMeta[]; onOpen: (image: AttachmentMeta) => void }) {
  return (
    <div className={styles.messageImages} data-count={Math.min(images.length, 4)}>
      {images.map((image) => (
        <motion.button key={image.id} type="button" className={styles.messageImage} layoutId={`image-${image.id}`} onClick={() => onOpen(image)} aria-label={`View ${image.name || 'image'}`}
          style={{ aspectRatio: images.length === 1 ? `${image.width} / ${image.height}` : undefined }}>
          <img src={attachmentUrl(image.id, true)} alt={image.name || 'Attached image'} loading="lazy" draggable={false} />
        </motion.button>
      ))}
    </div>
  );
}

/** Full-size view of an attached image, grown out of its thumbnail. */
export function Lightbox({ image, onClose }: { image: AttachmentMeta | null; onClose: () => void }) {
  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [image, onClose]);
  return createPortal(
    <AnimatePresence>
      {image && (
        <motion.div className={styles.lightbox} role="dialog" aria-label={image.name || 'Attached image'} onClick={onClose}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <motion.img layoutId={`image-${image.id}`} src={attachmentUrl(image.id)} alt={image.name || 'Attached image'}
            style={{ aspectRatio: `${image.width} / ${image.height}` }} transition={{ type: 'spring', stiffness: 380, damping: 36 }} />
          <motion.figcaption initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.12 } }} exit={{ opacity: 0 }}>
            {image.name || 'Image'} · {image.width} × {image.height}
          </motion.figcaption>
          <button type="button" className={styles.lightboxClose} aria-label="Close" onClick={onClose}><X size={16} /></button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
