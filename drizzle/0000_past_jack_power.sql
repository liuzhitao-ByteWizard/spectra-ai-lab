CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`task` text NOT NULL,
	`source` text NOT NULL,
	`result_label` text NOT NULL,
	`result_value` text NOT NULL,
	`quality` text NOT NULL,
	`payload` text NOT NULL
);
