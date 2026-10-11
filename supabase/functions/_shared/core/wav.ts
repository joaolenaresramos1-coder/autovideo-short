// Minimal WAV/PCM helpers. Gemini 3.8 TTS returns WAV (RIFF) by default;
// older TTS models return raw 16-bit PCM (audio/L16;rate=24000).

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationSeconds: number;
}

function str(b: Uint8Array, o: number, n: number): string {
  return String.fromCharCode(...b.subarray(o, o + n));
}

export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.length < 44 || str(bytes, 0, 4) !== "RIFF" || str(bytes, 8, 4) !== "WAVE") {
    throw new Error("Áudio não é um WAV válido");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  while (o + 8 <= bytes.length) {
    const id = str(bytes, o, 4);
    let size = dv.getUint32(o + 4, true);
    if (id === "fmt ") {
      fmt = { channels: dv.getUint16(o + 10, true), sampleRate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV sem bloco fmt");
      // Streaming encoders may write 0 or 0xFFFFFFFF as the data size.
      if (size === 0 || size === 0xffffffff || o + 8 + size > bytes.length) size = bytes.length - (o + 8);
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        dataOffset: o + 8,
        dataBytes: size,
        durationSeconds: size / bytesPerSec,
      };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("WAV sem bloco data");
}

export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bits = 16): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * (bits / 8), true);
  dv.setUint16(32, channels * (bits / 8), true);
  dv.setUint16(34, bits, true);
  w(36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Parse "audio/L16;codec=pcm;rate=24000" style mime types. */
export function parsePcmMime(mime: string): { sampleRate: number } | null {
  if (!/audio\/l16|audio\/pcm/i.test(mime)) return null;
  const m = /rate=(\d+)/i.exec(mime);
  return { sampleRate: m ? Number(m[1]) : 24000 };
}

/** Normalise any Gemini audio payload to WAV bytes. */
export function toWav(bytes: Uint8Array, mime: string): Uint8Array {
  if (/wav/i.test(mime) || (bytes.length > 12 && str(bytes, 0, 4) === "RIFF")) return bytes;
  const pcm = parsePcmMime(mime);
  if (pcm) return pcmToWav(bytes, pcm.sampleRate);
  throw new Error(`Formato de áudio não suportado: ${mime}`);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
