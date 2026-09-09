import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const experiments = sqliteTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    task: text("task", { enum: ["A", "B"] }).notNull(),
    source: text("source").notNull(),
    resultLabel: text("result_label").notNull(),
    resultValue: text("result_value").notNull(),
    quality: text("quality").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [index("idx_experiments_created_at").on(table.createdAt)],
);
