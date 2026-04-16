/**
 * aiConfig.ts — Central AI Model Configuration
 *
 * Single source of truth for all OpenAI model names used in this platform.
 * Import PRIMARY_MODEL (and EMBEDDING_MODEL) from here — never hardcode model
 * strings in individual route or pass files.
 *
 * AI is RESEARCH ONLY. These models must NOT gate live trade execution.
 * verifySignal() in openai.ts is a pre-existing live-path exception; all new
 * AI calls must be research-only and import PRIMARY_MODEL from here.
 */

export const PRIMARY_MODEL = "gpt-5.1" as const;
export const FALLBACK_MODEL = "gpt-5-mini" as const;
export const EMBEDDING_MODEL = "text-embedding-3-large" as const;

export const MAX_RETRIEVAL_TOKENS = 20_000;
export const RETRIEVAL_CHARS_PER_TOKEN = 4;
export const MAX_RETRIEVAL_CHARS = MAX_RETRIEVAL_TOKENS * RETRIEVAL_CHARS_PER_TOKEN;
