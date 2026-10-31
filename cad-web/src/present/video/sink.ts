/**
 * Where an encoded video's bytes go while it's made: a list of Blobs, so the browser may keep a long video on disk
 * rather than in memory. The muxer writes in order, except that it goes back to fill in headers once it knows them
 * (an MP4's reserved metadata, a WebM's sizes): those writes are kept as patches and spliced in at the end, by slicing
 * the Blobs (no copy).
 */
export class BlobSink {
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private patches: { position: number; data: Uint8Array }[] = [];
  /** Bytes in `parts`: what's before that can't be changed in place. */
  private sealed = 0;
  /** Bytes written in order so far. */
  size = 0;

  /** `batch`: bytes gathered before they go into a Blob. */
  private readonly batch: number;

  constructor(batch = 4 << 20) { this.batch = batch; }

  write(data: Uint8Array, position: number) {
    if (position > this.size) this.append(new Uint8Array(position - this.size));
    if (position < this.size) {
      // Back over what's written: a patch, and whatever runs past the end is appended.
      const inside = Math.min(data.length, this.size - position);
      this.patch(data.subarray(0, inside), position);
      if (inside < data.length) this.append(data.slice(inside));
      return;
    }
    this.append(data.slice());
  }

  private append(data: Uint8Array) {
    this.pending.push(data);
    this.pendingBytes += data.length;
    this.size += data.length;
    if (this.pendingBytes >= this.batch) this.seal();
  }

  /** Overwrites bytes already written: in place while they're still in memory, else spliced in at the end. */
  private patch(data: Uint8Array, position: number) {
    let from = 0;
    if (position < this.sealed) {
      const before = Math.min(data.length, this.sealed - position);
      this.patches.push({ position, data: data.slice(0, before) });
      from = before;
    }
    let offset = this.sealed;
    for (const part of this.pending) {
      if (from >= data.length) break;
      const at = position + from;
      if (at < offset + part.length) {
        const count = Math.min(data.length - from, offset + part.length - at);
        part.set(data.subarray(from, from + count), at - offset);
        from += count;
      }
      offset += part.length;
    }
  }

  private seal() {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending as BlobPart[]));
    this.sealed += this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** The file: everything written, with the patches applied in the order they came. */
  blob(type: string): Blob {
    this.seal();
    let blob = new Blob(this.parts, { type });
    for (const { position, data } of this.patches) {
      blob = new Blob([blob.slice(0, position), data as BlobPart, blob.slice(position + data.length)], { type });
    }
    return blob;
  }

  /** A WritableStream for the muxer's StreamTarget. */
  stream(): WritableStream<{ type: 'write'; data: Uint8Array; position: number }> {
    return new WritableStream({ write: (chunk) => this.write(chunk.data, chunk.position) });
  }
}
