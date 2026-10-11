// Video validation from ffprobe output (run by the worker).

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  pix_fmt?: string;
}

export interface Probe {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string; format_name?: string };
}

export interface ValidationInput {
  probe: Probe;
  decodeErrors: string;
  expectedDuration: number;
  minSeconds: number;
  maxSeconds: number;
  captionEvents: number;
  captionsRequired: boolean;
  width?: number;
  height?: number;
}

export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: ValidationCheck[];
  duration: number;
  width: number;
  height: number;
  sizeBytes: number;
}

export function validateVideo(v: ValidationInput): ValidationReport {
  const W = v.width ?? 1080;
  const H = v.height ?? 1920;
  const streams = v.probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(v.probe.format?.duration ?? video?.duration ?? 0);
  const size = Number(v.probe.format?.size ?? 0);
  const checks: ValidationCheck[] = [
    { name: "arquivo", ok: !!video && size > 50_000, detail: `${size} bytes, formato ${v.probe.format?.format_name ?? "?"}` },
    { name: "resolução", ok: video?.width === W && video?.height === H, detail: `${video?.width ?? 0}x${video?.height ?? 0} (esperado ${W}x${H})` },
    { name: "codec", ok: video?.codec_name === "h264" && (video?.pix_fmt ?? "yuv420p") === "yuv420p", detail: `${video?.codec_name ?? "?"}/${video?.pix_fmt ?? "?"}` },
    { name: "áudio", ok: !!audio, detail: audio ? `${audio.codec_name}` : "sem faixa de áudio" },
    {
      name: "duração",
      ok: duration >= v.minSeconds - 0.5 && duration <= v.maxSeconds + 0.5 && Math.abs(duration - v.expectedDuration) <= 1.0,
      detail: `${duration.toFixed(2)} s (esperado ${v.expectedDuration.toFixed(2)} s, limites ${v.minSeconds}–${v.maxSeconds} s)`,
    },
    {
      name: "legendas",
      ok: !v.captionsRequired || v.captionEvents > 0,
      detail: v.captionsRequired ? `${v.captionEvents} eventos de legenda` : "não aplicável",
    },
    {
      name: "decodificação",
      ok: v.decodeErrors.trim().length === 0,
      detail: v.decodeErrors.trim() ? v.decodeErrors.trim().slice(0, 300) : "sem erros",
    },
  ];
  return {
    ok: checks.every((c) => c.ok),
    checks,
    duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    sizeBytes: size,
  };
}
