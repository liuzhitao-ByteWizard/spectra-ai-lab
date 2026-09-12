ALTER TABLE `experiments` ADD `user_id` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `last_mutation_id` text;--> statement-breakpoint
ALTER TABLE `experiments` ADD `status` text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `steps` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `diagnosis` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `experiments` ADD `image_keys` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_experiments_user_updated_at` ON `experiments` (`user_id`,`updated_at`);