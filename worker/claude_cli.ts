// Claude Code in print mode, signed in with the user's Claude subscription
// (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`). The page images are
// written to a temporary folder and Claude reads them with its Read tool; the
// answer comes back validated against the step's JSON Schema.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepError } from "../supabase/functions/_shared/core/backoff.ts";
import type { ClaudeCliFn } from "../supabase/functions/_shared/pipeline/context.ts";
import { run } from "./ffmpeg.ts";

interface CliResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

/** JSON object in the reply text (fenced or with words around it). */
function jsonFrom(text: string): unknown {
  const clean = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const a = clean.indexOf("{");
    const b = clean.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(clean.slice(a, b + 1));
    throw new Error("sem JSON");
  }
}

export function claudeCli(bin = process.env.CLAUDE_BIN ?? "claude"): ClaudeCliFn {
  return async ({ model, prompt, images, schema, timeoutMs }) => {
    const dir = await mkdtemp(join(tmpdir(), "claude-ai-"));
    try {
      const lines: string[] = [];
      for (const img of images) {
        await writeFile(join(dir, img.name), img.bytes);
        lines.push(`- ${img.name}`);
      }
      const full = images.length
        ? `${prompt}\n\nAs imagens estão nesta pasta; leia TODAS com a ferramenta Read, na ordem:\n${lines.join("\n")}\n\nResponda apenas com o JSON pedido.`
        : `${prompt}\n\nResponda apenas com o JSON pedido.`;
      const args = [
        "-p", "--output-format", "json", "--model", model,
        "--json-schema", JSON.stringify(schema),
        "--tools", images.length ? "Read" : "", ...(images.length ? ["--allowedTools", "Read"] : []),
        "--safe-mode",
      ];
      const r = await run(bin, args, { timeoutMs, input: Buffer.from(full), cwd: dir });
      let out: CliResult | null = null;
      try {
        out = JSON.parse(r.stdout.toString()) as CliResult;
      } catch {
        // not JSON: the CLI failed before answering
      }
      const message = (out?.result ?? r.stderr ?? "").slice(0, 400);
      if (!out || out.is_error || r.code !== 0) {
        if (/limit|rate|usage|quota|overloaded|529|429/i.test(message)) {
          throw new StepError(`Claude (assinatura): limite de uso atingido; nova tentativa mais tarde. ${message}`, "waiting", 3600);
        }
        if (/auth|login|token|401|403|credential/i.test(message)) {
          throw new StepError(`Claude (assinatura): token inválido ou expirado — gere outro com "claude setup-token". ${message}`, "config");
        }
        if (r.code === -1 || /SIGKILL|timed? ?out/i.test(message)) {
          throw new StepError(`Claude (assinatura): sem resposta no tempo limite (${Math.round(timeoutMs / 1000)} s)`, "retryable");
        }
        throw new StepError(`Claude (assinatura) falhou: ${message || `código ${r.code}`}`, "retryable");
      }
      let data: unknown = out.structured_output;
      if (data === undefined || data === null) {
        try {
          data = jsonFrom(out.result ?? "");
        } catch {
          throw new StepError("Claude (assinatura) não retornou JSON válido", "retryable");
        }
      }
      return {
        data,
        inputTokens: (out.usage?.input_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0),
        outputTokens: out.usage?.output_tokens ?? 0,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
