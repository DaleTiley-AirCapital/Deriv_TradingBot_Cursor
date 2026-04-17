/**
 * contextRetriever.ts — Embedding-based Context Retrieval Layer
 *
 * Provides vector-similarity context retrieval for all AI research calls.
 * Uses text-embedding-3-large to embed chunks and cosine similarity to find
 * the top-k most relevant chunks for a given query.
 *
 * RESEARCH ONLY — must never be called from the live trading loop.
 *
 * Exports:
 *   embedText()              — generate embedding for a text string
 *   upsertChunk()            — embed + store/update a chunk (idempotent by sourceId)
 *   retrieveContext()        — embed query → cosine similarity → formatted string
 *   indexRepoContext()       — index key repo modules (engine logic, calibration)
 *   indexSchemaContext()     — index DB schema definitions
 *   indexStrategyContext()   — index strategy definitions & philosophy
 *   indexCalibrationContext()— index latest calibration profile outputs
 */

import { db, aiContextEmbeddingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { getOpenAIClient } from "../../infrastructure/openai.js";
import { EMBEDDING_MODEL, MAX_RETRIEVAL_CHARS } from "./aiConfig.js";

const WORKSPACE_ROOT = resolve(process.cwd());

function safeRead(relPath: string, maxChars = 40_000): string {
  const full = join(WORKSPACE_ROOT, relPath);
  if (!existsSync(full)) return `[File not found: ${relPath}]`;
  return readFileSync(full, "utf-8").slice(0, maxChars);
}

/**
 * Split a TypeScript/JS file into function/export-level chunks.
 * Returns an array of { id, text } where each chunk represents one
 * logical unit (export function, export const, class, etc.).
 * Falls back to a single chunk if no split boundaries are found.
 */
function chunkByFunctions(
  relPath: string,
  baseId: string,
  maxCharsPerChunk = 5_000,
): Array<{ id: string; text: string }> {
  const content = safeRead(relPath, 80_000);
  if (content.startsWith("[File not found")) {
    return [{ id: baseId, text: content }];
  }

  const lines = content.split("\n");
  const chunks: Array<{ id: string; text: string }> = [];
  let currentLines: string[] = [];
  let chunkIndex = 0;
  let currentName = "header";

  const BOUNDARY = /^(export\s+(async\s+)?function\s+(\w+)|export\s+(const|let|var)\s+(\w+)|export\s+(class|interface|type|enum)\s+(\w+)|\/\/\s*─{10,})/;

  function flush() {
    const text = currentLines.join("\n").trim();
    if (text.length > 50) {
      chunks.push({
        id: `${baseId}:chunk-${chunkIndex}-${currentName}`,
        text: `# Source: ${relPath} — ${currentName}\n\n${text.slice(0, maxCharsPerChunk)}`,
      });
      chunkIndex++;
    }
    currentLines = [];
  }

  for (const line of lines) {
    const match = BOUNDARY.exec(line);
    if (match && currentLines.length > 0) {
      flush();
      const fnName = match[3] ?? match[5] ?? match[7] ?? "section";
      currentName = fnName.replace(/[^a-z0-9_]/gi, "-").slice(0, 40);
    }
    currentLines.push(line);
  }
  flush();

  if (chunks.length === 0) {
    return [{ id: baseId, text: `# Source: ${relPath}\n\n${content.slice(0, maxCharsPerChunk)}` }];
  }
  return chunks;
}

// ── Embedding ─────────────────────────────────────────────────────────────────

export async function embedText(text: string): Promise<number[]> {
  const client = await getOpenAIClient();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8_000),
  });
  return response.data[0]?.embedding ?? [];
}

// ── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Token budget guard ────────────────────────────────────────────────────────

export function truncateToTokenBudget(text: string, maxChars = MAX_RETRIEVAL_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n[...context truncated to stay within token budget]";
}

// ── Upsert chunk ──────────────────────────────────────────────────────────────

export async function upsertChunk(opts: {
  sourceType: "code" | "schema" | "strategy" | "calibration" | "data_summary";
  sourceId: string;
  contentText: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { sourceType, sourceId, contentText, metadata } = opts;
  const embedding = await embedText(contentText);

  await db
    .insert(aiContextEmbeddingsTable)
    .values({
      sourceType,
      sourceId,
      contentText,
      embeddingVector: embedding,
      metadataJson: metadata ?? {},
    })
    .onConflictDoUpdate({
      target: aiContextEmbeddingsTable.sourceId,
      set: {
        contentText,
        embeddingVector: embedding,
        metadataJson: metadata ?? {},
        createdAt: new Date(),
      },
    });
}

// ── Retrieve context ──────────────────────────────────────────────────────────

export async function retrieveContext(
  query: string,
  topK = 6,
): Promise<string> {
  const allRows = await db.select({
    sourceId:    aiContextEmbeddingsTable.sourceId,
    sourceType:  aiContextEmbeddingsTable.sourceType,
    contentText: aiContextEmbeddingsTable.contentText,
    embedding:   aiContextEmbeddingsTable.embeddingVector,
  }).from(aiContextEmbeddingsTable);

  if (allRows.length === 0) return "";

  const queryEmbedding = await embedText(query);

  const scored = allRows.map(row => ({
    sourceId:    row.sourceId,
    sourceType:  row.sourceType,
    contentText: row.contentText,
    score:       cosineSimilarity(queryEmbedding, row.embedding as number[]),
  })).sort((a, b) => b.score - a.score).slice(0, topK);

  const sourceTypes = [...new Set(scored.map(r => r.sourceType))].join(", ");
  console.log(
    `[Retrieval] Query: "${query.slice(0, 80)}..." → ${scored.length} chunks (${sourceTypes}) top-score=${scored[0]?.score.toFixed(3) ?? "N/A"}`,
    `\nPreview: ${scored[0]?.contentText.slice(0, 200) ?? ""}`,
  );

  const chunks = scored.map((r, i) =>
    `### Context ${i + 1} [${r.sourceType}/${r.sourceId}]\n${r.contentText}`,
  ).join("\n\n");

  return truncateToTokenBudget(chunks);
}

// ── Ingestion: Repo Code ──────────────────────────────────────────────────────

export async function indexRepoContext(): Promise<number> {
  const fileSources: Array<{ id: string; relPath: string; meta: Record<string, unknown> }> = [
    { id: "repo:precursor-pass",   relPath: "artifacts/api-server/src/core/calibration/passes/precursorPass.ts",   meta: { type: "calibration_pass" } },
    { id: "repo:trigger-pass",     relPath: "artifacts/api-server/src/core/calibration/passes/triggerPass.ts",     meta: { type: "calibration_pass" } },
    { id: "repo:behavior-pass",    relPath: "artifacts/api-server/src/core/calibration/passes/behaviorPass.ts",    meta: { type: "calibration_pass" } },
    { id: "repo:extraction-pass",  relPath: "artifacts/api-server/src/core/calibration/passes/extractionPass.ts",  meta: { type: "calibration_pass" } },
    { id: "repo:pass-runner",      relPath: "artifacts/api-server/src/core/calibration/calibrationPassRunner.ts",  meta: { type: "calibration" } },
    { id: "repo:openai-infra",     relPath: "artifacts/api-server/src/infrastructure/openai.ts",                   meta: { type: "infrastructure" } },
    { id: "repo:backtest-engine",  relPath: "artifacts/api-server/src/runtimes/backtestEngine.ts",                 meta: { type: "backtest" } },
    { id: "repo:ai-context",       relPath: "artifacts/api-server/src/routes/aiContext.ts",                        meta: { type: "route" } },
  ];

  let count = 0;
  for (const { id, relPath, meta } of fileSources) {
    const chunks = chunkByFunctions(relPath, id);
    for (const chunk of chunks) {
      await upsertChunk({
        sourceType: "code",
        sourceId: chunk.id,
        contentText: chunk.text,
        metadata: meta,
      });
      count++;
    }
  }
  return count;
}

// ── Ingestion: DB Schema ──────────────────────────────────────────────────────

export async function indexSchemaContext(): Promise<number> {
  const schemaFiles: Array<{ id: string; relPath: string }> = [
    { id: "schema:detected-moves",          relPath: "lib/db/src/schema/detectedMoves.ts" },
    { id: "schema:calibration-pass-runs",   relPath: "lib/db/src/schema/calibrationPassRuns.ts" },
    { id: "schema:calib-profiles",          relPath: "lib/db/src/schema/strategyCalibrationProfiles.ts" },
    { id: "schema:trades",                  relPath: "lib/db/src/schema/trades.ts" },
    { id: "schema:candles",                 relPath: "lib/db/src/schema/candles.ts" },
    { id: "schema:move-behavior-passes",    relPath: "lib/db/src/schema/moveBehaviorPasses.ts" },
    { id: "schema:move-precursor-passes",   relPath: "lib/db/src/schema/movePrecursorPasses.ts" },
    { id: "schema:backtest-runs",           relPath: "lib/db/src/schema/backtestRuns.ts" },
    { id: "schema:signal-log",             relPath: "lib/db/src/schema/signalLog.ts" },
    { id: "schema:platform-state",         relPath: "lib/db/src/schema/platformState.ts" },
  ];

  let count = 0;
  for (const { id, relPath } of schemaFiles) {
    const chunks = chunkByFunctions(relPath, id);
    for (const chunk of chunks) {
      await upsertChunk({
        sourceType: "schema",
        sourceId: chunk.id,
        contentText: chunk.text.replace(/^# Source:/, "# Schema:"),
      });
      count++;
    }
  }
  return count;
}

// ── Ingestion: Strategy Definitions ─────────────────────────────────────────

export async function indexStrategyContext(): Promise<number> {
  const skillContent = safeRead(".agents/skills/deriv-trading-strategy/SKILL.md", 40_000);
  const sections = skillContent.split(/^## /m).filter(s => s.trim().length > 50);

  let count = 0;
  for (let i = 0; i < sections.length; i++) {
    const sectionText = sections[i];
    const titleEnd = sectionText.indexOf("\n");
    const title = sectionText.slice(0, titleEnd).trim().replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
    const text = `## ${sectionText}`.slice(0, 6000);
    await upsertChunk({
      sourceType: "strategy",
      sourceId: `strategy:skill-section-${i}-${title}`,
      contentText: text,
      metadata: { source: "deriv-trading-strategy/SKILL.md", section: title },
    });
    count++;
  }
  return count;
}

// ── Ingestion: Calibration Outputs ───────────────────────────────────────────

export async function indexCalibrationContext(): Promise<number> {
  let count = 0;
  try {
    const { strategyCalibrationProfilesTable } = await import("@workspace/db");
    const profiles = await db.select().from(strategyCalibrationProfilesTable);

    for (const p of profiles) {
      const feeddown = p.feeddownSchema as Record<string, unknown> | null;
      const profitability = p.profitabilitySummary as Record<string, unknown> | null;

      const text = `# Calibration Profile: ${p.symbol} (moveType=${p.moveType})
Generated: ${p.generatedAt?.toISOString() ?? "unknown"} | Window: ${p.windowDays}d

Honest Fit: ${p.capturedMoves}/${p.targetMoves} moves captured (${(p.fitScore * 100).toFixed(1)}%)
Missed: ${p.missedMoves} | Miss reasons: ${JSON.stringify(p.missReasons ?? []).slice(0, 200)}

Move stats: avg ${p.avgMovePct?.toFixed(1)}% | median ${p.medianMovePct?.toFixed(1)}% | avg hold ${p.avgHoldingHours?.toFixed(1)}h
Holdability: ${p.avgHoldabilityScore?.toFixed(2) ?? "N/A"} | Capturable: ${((p.avgCaptureablePct ?? 0) * 100).toFixed(1)}%

${feeddown?.overallFitNarrative ? `Fit narrative: ${feeddown.overallFitNarrative}` : ""}
${feeddown?.topImprovementOpportunity ? `Top opportunity: ${feeddown.topImprovementOpportunity}` : ""}
${profitability ? `Top extraction path: ${(profitability as { topPath?: string }).topPath ?? "N/A"}` : ""}`;

      await upsertChunk({
        sourceType: "calibration",
        sourceId: `calibration:${p.symbol}:${p.moveType}`,
        contentText: text.slice(0, 4000),
        metadata: { symbol: p.symbol, moveType: p.moveType },
      });
      count++;
    }
  } catch (err) {
    console.warn("[ContextRetriever] calibration indexing skipped:", err instanceof Error ? err.message : err);
  }
  return count;
}
