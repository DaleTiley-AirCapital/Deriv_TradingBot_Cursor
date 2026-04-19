/**
 * Parse JSON from LLM chat output: balanced `{…}` extraction, markdown fences,
 * unicode quote normalization, trailing commas, and jsonrepair fallback.
 */

import { jsonrepair } from "jsonrepair";

function stripMarkdownFences(text: string): string {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  return s.trim();
}

/** Remove invisible chars; map smart quotes to ASCII (common LLM slip). */
export function normalizeLlmJsonText(s: string): string {
  return s
    .replace(/\uFEFF/g, "")
    .replace(/[\u200b-\u200d]/g, "")
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'");
}

/** First top-level `{` … `}` span with string-aware brace matching. */
export function extractFirstJsonObject(text: string): string | null {
  const stripped = stripMarkdownFences(normalizeLlmJsonText(text));
  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

function stripTrailingCommas(json: string): string {
  let out = json;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(/,(\s*[\]}])/g, "$1");
  }
  return out;
}

function snippetAround(text: string, pos: number, radius = 120): string {
  const i = Math.max(0, Math.min(pos, text.length));
  const a = Math.max(0, i - radius);
  const b = Math.min(text.length, i + radius);
  const pad = Math.min(radius, i - a);
  return `${text.slice(a, b)}\n${" ".repeat(pad)}^`;
}

function parseErrorPosition(msg: string): number | null {
  const m = /position (\d+)/i.exec(msg);
  if (!m) return null;
  return Number(m[1]);
}

function parseJsonRobust(s: string, ctx: string): unknown {
  const attempts: Array<() => unknown> = [
    () => JSON.parse(stripTrailingCommas(s)),
    () => {
      const repaired = jsonrepair(s);
      return JSON.parse(repaired);
    },
    () => {
      const repaired = jsonrepair(stripTrailingCommas(s));
      return JSON.parse(repaired);
    },
  ];
  let last: unknown;
  for (const fn of attempts) {
    try {
      return fn();
    } catch (e) {
      last = e;
    }
  }
  const msg = last instanceof Error ? last.message : String(last);
  const pos = parseErrorPosition(msg);
  const diag =
    pos !== null && pos >= 0 && pos <= s.length ? `\nContext:\n${snippetAround(s, pos)}` : "";
  throw new Error(`${ctx}: ${msg}${diag}`);
}

export function parseAiJsonObject<T = Record<string, unknown>>(raw: string): T {
  const normalized = normalizeLlmJsonText(raw);
  const trimmed = stripMarkdownFences(normalized).trim();

  if (trimmed.startsWith("{")) {
    try {
      return parseJsonRobust(trimmed, "JSON.parse(full)") as T;
    } catch {
      /* try extracted object (e.g. reasoning prefix before JSON) */
    }
  }

  const candidate = extractFirstJsonObject(raw);
  if (!candidate) {
    throw new Error("No JSON object in AI response");
  }
  return parseJsonRobust(candidate, "JSON.parse(extracted)") as T;
}
