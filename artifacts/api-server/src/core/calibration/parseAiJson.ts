/**
 * Parse JSON from LLM chat output: balanced `{…}` extraction, markdown fences,
 * and common syntax slips (trailing commas). Avoids greedy `/\{[\s\S]*\}/` which
 * can grab multiple objects or a truncated tail.
 */

function stripMarkdownFences(text: string): string {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  return s.trim();
}

/** First top-level `{` … `}` span with string-aware brace matching. */
export function extractFirstJsonObject(text: string): string | null {
  const stripped = stripMarkdownFences(text);
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

/** Remove trailing commas before `}` and `]` (invalid JSON but common in LLM output). */
function stripTrailingCommas(json: string): string {
  let out = json;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(/,(\s*[\]}])/g, "$1");
  }
  return out;
}

export function parseAiJsonObject<T = Record<string, unknown>>(raw: string): T {
  const candidate = extractFirstJsonObject(raw);
  if (!candidate) {
    throw new Error("No JSON object in AI response");
  }
  try {
    return JSON.parse(candidate) as T;
  } catch (e1) {
    try {
      return JSON.parse(stripTrailingCommas(candidate)) as T;
    } catch {
      const msg = e1 instanceof Error ? e1.message : String(e1);
      throw new Error(`Invalid JSON in AI response: ${msg}`);
    }
  }
}
