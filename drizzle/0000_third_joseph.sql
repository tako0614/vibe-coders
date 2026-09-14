CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`createdAt` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`wait` text
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversationId` text NOT NULL,
	`type` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`consumed` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_key_unique` ON `events` (`key`);--> statement-breakpoint
CREATE INDEX `events_inbox` ON `events` (`conversationId`,`consumed`,`id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`conversationId` text NOT NULL,
	`body` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_unique` ON `messages` (`id`);--> statement-breakpoint
CREATE INDEX `messages_conversation` ON `messages` (`conversationId`,`seq`);--> statement-breakpoint
CREATE TABLE `human_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`spec` text NOT NULL,
	`dedupeKey` text,
	`targetVersion` integer,
	`state` text DEFAULT 'pending' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`operationId` text,
	`result` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `request_dedupe` ON `human_requests` (`conversationId`,`dedupeKey`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`cwd` text NOT NULL,
	`host` text NOT NULL,
	`state` text NOT NULL,
	`exitCode` integer,
	`output` text DEFAULT '' NOT NULL,
	`outputOffset` integer DEFAULT 0 NOT NULL,
	`result` text,
	`owner` text DEFAULT 'agent' NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`endedAt` integer,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`action` text DEFAULT 'prompt' NOT NULL,
	`nextAt` integer NOT NULL,
	`intervalMs` integer,
	`enabled` integer NOT NULL,
	`timeZone` text NOT NULL,
	`source` text DEFAULT 'local' NOT NULL,
	`lastAt` integer,
	`lastOutcome` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
