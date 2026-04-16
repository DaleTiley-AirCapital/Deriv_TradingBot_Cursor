import { pgTable, serial, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiContextEmbeddingsTable = pgTable("ai_context_embeddings", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull().unique(),
  contentText: text("content_text").notNull(),
  embeddingVector: jsonb("embedding_vector").notNull().$type<number[]>(),
  metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAiContextEmbeddingSchema = createInsertSchema(aiContextEmbeddingsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAiContextEmbedding = z.infer<typeof insertAiContextEmbeddingSchema>;
export type AiContextEmbeddingRow = typeof aiContextEmbeddingsTable.$inferSelect;
