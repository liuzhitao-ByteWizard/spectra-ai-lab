CREATE TABLE `experiment_journeys` (
	`user_id` text PRIMARY KEY NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
