export interface SniffedMedia {
  contentType: 'video/mp4' | 'audio/mp4' | 'video/quicktime' | 'video/webm' | 'video/ogg' | 'audio/ogg' | 'audio/wav' | 'audio/mpeg' | 'audio/flac';
  kind: 'video' | 'audio';
}

const audioBrands = new Set(['M4A ', 'M4B ', 'M4P ']);
const videoBrands = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV']);

function ascii(bytes: Uint8Array, start: number, end: number) {
  return Buffer.from(bytes.subarray(start, end)).toString('ascii');
}

export function sniffRaster(bytes: Uint8Array): string | null {
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 12))) return 'image/avif';
  return null;
}

function isMp3Frame(bytes: Uint8Array) {
  if (bytes.length < 2 || bytes[0] !== 0xff) return false;
  const next = bytes[1];
  if ((next & 0xe0) !== 0xe0) return false;
  const version = (next >> 3) & 0x03;
  const layer = (next >> 1) & 0x03;
  return version !== 1 && layer !== 0;
}

/** Magic-byte allowlist. Client Content-Type is ignored. SVG, HTML and unknown bytes are not media. */
export function sniffMedia(prefix: Uint8Array): SniffedMedia | null {
  if (prefix.length >= 12 && ascii(prefix, 4, 8) === 'ftyp') {
    const brand = ascii(prefix, 8, 12);
    if (audioBrands.has(brand)) return { contentType: 'audio/mp4', kind: 'audio' };
    if (brand === 'qt  ') return { contentType: 'video/quicktime', kind: 'video' };
    if (videoBrands.has(brand)) return { contentType: 'video/mp4', kind: 'video' };
    return null;
  }
  if (prefix.length >= 4 && prefix[0] === 0x1a && prefix[1] === 0x45 && prefix[2] === 0xdf && prefix[3] === 0xa3) {
    return Buffer.from(prefix).includes(Buffer.from('webm')) ? { contentType: 'video/webm', kind: 'video' } : null;
  }
  if (ascii(prefix, 0, 4) === 'OggS') {
    const text = Buffer.from(prefix).toString('latin1');
    if (text.includes('theora')) return { contentType: 'video/ogg', kind: 'video' };
    if (text.includes('OpusHead') || text.includes('vorbis') || text.includes('FLAC')) return { contentType: 'audio/ogg', kind: 'audio' };
    return null;
  }
  if (prefix.length >= 12 && ascii(prefix, 0, 4) === 'RIFF' && ascii(prefix, 8, 12) === 'WAVE') return { contentType: 'audio/wav', kind: 'audio' };
  if (ascii(prefix, 0, 4) === 'fLaC') return { contentType: 'audio/flac', kind: 'audio' };
  if (ascii(prefix, 0, 3) === 'ID3' || isMp3Frame(prefix)) return { contentType: 'audio/mpeg', kind: 'audio' };
  return null;
}

/** `null` means the header was absent or ignored. Unsatisfiable ranges are a distinct result. */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (size <= 0) return 'unsatisfiable';
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return start >= size ? 'unsatisfiable' : null;
  const end = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
