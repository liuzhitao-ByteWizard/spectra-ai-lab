CREATE TABLE `feedback_messages` (
  `id` text PRIMARY KEY NOT NULL,
  `category` text DEFAULT '其他' NOT NULL,
  `message` text NOT NULL,
  `contact` text DEFAULT '' NOT NULL,
  `page` text DEFAULT '' NOT NULL,
  `user_id` text,
  `user_email` text,
  `fingerprint` text NOT NULL,
  `user_agent` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_feedback_created_at` ON `feedback_messages` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_feedback_fingerprint_created_at` ON `feedback_messages` (`fingerprint`,`created_at`);
