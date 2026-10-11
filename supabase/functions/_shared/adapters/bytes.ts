import { StepError } from "../core/backoff.ts";
import { type FetchLike, http, ensureOk } from "./http.ts";

/** Random-access source of bytes, so large files are uploaded in chunks
 * without keeping the whole video in the Edge Function's memory. */
export interface ByteSource {
  size: number;
  contentType: string;
  read(start: number, endExclusive: number): Promise<Uint8Array>;
}

export function memorySource(bytes: Uint8Array, contentType = "video/mp4"): ByteSource {
  return {
    size: bytes.length,
    contentType,
    read: async (s, e) => bytes.subarray(s, Math.min(e, bytes.length)),
  };
}

/** Reads ranges of a (signed) URL with HTTP Range requests. */
export function urlSource(fetchFn: FetchLike, url: string, size: number, contentType = "video/mp4"): ByteSource {
  return {
    size,
    contentType,
    async read(start, endExclusive) {
      const end = Math.min(endExclusive, size) - 1;
      const res = await ensureOk(
        await http(fetchFn, url, { headers: { range: `bytes=${start}-${end}` }, service: "Storage", timeoutMs: 90_000 }),
        "Storage",
      );
      const buf = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200 && buf.length === size) return buf.subarray(start, end + 1);
      if (buf.length !== end - start + 1) {
        throw new StepError(`Storage devolveu ${buf.length} bytes, esperado ${end - start + 1}`, "retryable");
      }
      return buf;
    },
  };
}
