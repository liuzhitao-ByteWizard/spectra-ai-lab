import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const experiments = sqliteTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().default("legacy"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
    version: integer("version").notNull().default(1),
    lastMutationId: text("last_mutation_id"),
    task: text("task", { enum: ["A", "B"] }).notNull(),
    source: text("source").notNull(),
    resultLabel: text("result_label").notNull(),
    resultValue: text("result_value").notNull(),
    quality: text("quality").notNull(),
    status: text("status", { enum: ["draft", "completed", "needs_review"] }).notNull().default("completed"),
    steps: text("steps").notNull().default("[]"),
    diagnosis: text("diagnosis").notNull().default(""),
    imageKeys: text("image_keys").notNull().default("{}"),
    payload: text("payload").notNull(),
  },
  (table) => [
    index("idx_experiments_created_at").on(table.createdAt),
    index("idx_experiments_user_updated_at").on(table.userId, table.updatedAt),
  ],
);

export const experimentJourneys = sqliteTable("experiment_journeys", {
  userId: text("user_id").primaryKey(),
  payload: text("payload").notNull().default("{}"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
});
