CREATE TABLE `ai_usage_daily` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `idx_ai_usage_daily_day` ON `ai_usage_daily` (`day`);