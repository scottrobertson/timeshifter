-- Channels starred on the Channels page, which list first. Kept by name, like
-- subscriptions, so they survive the provider renumbering its channels.
CREATE TABLE starred_channels (
  name TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
  starred_at INTEGER NOT NULL
);
