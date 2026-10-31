/**
 * The Decal dialog's image (`model.decal(..., image="img_…")`): the workspace's uploaded images (app/decal_images.py)
 * as thumbnails to choose from, and an upload button. The value is the chosen image's id as Python source.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from '@/state/store';
import { setValue } from './dialog';
import type { Field } from './specs';
import styles from './Feature.module.css';
import { withWorkspace } from '@/teams/current';

export interface DecalImage { id: string; name: string; width: number; height: number; url: string; thumbnail_url: string }

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 8_000_000;

export async function uploadDecalImage(file: File): Promise<DecalImage> {
  if (!ACCEPTED.includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > MAX_BYTES) throw new Error('Images must be at most 8 MB.');
  return api<DecalImage>(`/v1/decal-images?name=${encodeURIComponent(file.name.slice(0, 200))}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
}

export default function ImageField({ field, value }: { field: Field; value: string }) {
  const [images, setImages] = useState<DecalImage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const chosen = /^["'](img_[0-9a-f]{12})["']$/.exec(value.trim())?.[1] ?? null;

  useEffect(() => {
    let alive = true;
    api<{ images: DecalImage[] }>('/v1/decal-images').then((data) => { if (alive) setImages(data.images); })
      .catch((error) => { if (alive) { setImages([]); toast('danger', 'Couldn’t load your images', (error as Error).message); } });
    return () => { alive = false; };
  }, []);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const image = await uploadDecalImage(file);
      setImages((list) => [image, ...(list ?? []).filter((item) => item.id !== image.id)]);
      setValue(field.key, JSON.stringify(image.id));
    } catch (error) {
      toast('danger', 'Couldn’t upload the image', (error as Error).message);
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  };

  return (
    <span className={styles.images}>
      <span className={styles.imageGrid} role="listbox" aria-label={field.label}>
        {(images ?? []).map((image) => (
          <button key={image.id} type="button" role="option" aria-selected={image.id === chosen} className={styles.imageOption} data-on={image.id === chosen || undefined}
            title={`${image.name} · ${image.width}×${image.height}`} onClick={() => setValue(field.key, JSON.stringify(image.id))}>
            <img src={withWorkspace(image.thumbnail_url)} alt={image.name} loading="lazy" draggable={false} />
          </button>
        ))}
        <button type="button" className={styles.imageUpload} disabled={busy} onClick={() => input.current?.click()} title="Upload a PNG, JPEG or WebP image">
          {busy ? <Loader2 size={14} className={styles.spin} /> : <Upload size={14} />}<span>Upload</span>
        </button>
      </span>
      {images === null && <span className={styles.empty}>Loading your images…</span>}
      {chosen && images && !images.some((image) => image.id === chosen) && <span className={styles.invalid}>{chosen} isn’t one of this workspace’s images.</span>}
      <input ref={input} type="file" accept={ACCEPTED.join(',')} hidden data-decal-upload onChange={(event) => void upload(event.target.files?.[0])} />
    </span>
  );
}
