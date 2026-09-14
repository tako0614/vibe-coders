ALTER TABLE `schedules` ADD `trigger` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `eventCursor` integer DEFAULT 0 NOT NULL;