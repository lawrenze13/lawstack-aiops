CREATE TABLE `user_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`agent_overrides_json` text DEFAULT '{}' NOT NULL,
	`notifications_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_notifications_seen` (
	`user_id` text PRIMARY KEY NOT NULL,
	`last_seen_audit_id` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
