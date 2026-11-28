DROP TABLE IF EXISTS `chat_message_text_fts`;--> statement-breakpoint
-- External-content trigram FTS5 index over `chat_message_text` so substring
-- transcript searches of 3+ characters avoid full table scans without storing
-- a duplicate copy of message prose.
CREATE VIRTUAL TABLE `chat_message_text_fts` USING fts5(
	`text`,
	content='chat_message_text',
	content_rowid='rowid',
	tokenize='trigram'
);--> statement-breakpoint
CREATE TRIGGER `chat_message_text_fts_ai` AFTER INSERT ON `chat_message_text` BEGIN
	INSERT INTO `chat_message_text_fts` (`rowid`, `text`) VALUES (NEW.`rowid`, NEW.`text`);
END;--> statement-breakpoint
CREATE TRIGGER `chat_message_text_fts_ad` AFTER DELETE ON `chat_message_text` BEGIN
	INSERT INTO `chat_message_text_fts` (`chat_message_text_fts`, `rowid`, `text`) VALUES ('delete', OLD.`rowid`, OLD.`text`);
END;--> statement-breakpoint
CREATE TRIGGER `chat_message_text_fts_au` AFTER UPDATE OF `text` ON `chat_message_text` BEGIN
	INSERT INTO `chat_message_text_fts` (`chat_message_text_fts`, `rowid`, `text`) VALUES ('delete', OLD.`rowid`, OLD.`text`);
	INSERT INTO `chat_message_text_fts` (`rowid`, `text`) VALUES (NEW.`rowid`, NEW.`text`);
END;--> statement-breakpoint
INSERT INTO `chat_message_text_fts` (`chat_message_text_fts`) VALUES ('rebuild');
