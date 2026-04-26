ALTER TABLE `user_prefs` ADD `credentials_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `runs` ADD `jira_token_source` text;
--> statement-breakpoint
ALTER TABLE `runs` ADD `github_token_source` text;
