-- Named sets of filename and .nfo templates, picked on the download page. value is
-- the JSON preset. Blank templates and padding follow the settings.
CREATE TABLE presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  value TEXT NOT NULL
);
