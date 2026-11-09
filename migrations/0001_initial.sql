-- Single values stored as JSON. "settings" is everything on the Settings page,
-- "last_check" is what the most recent guide check found, for the Overview page.
CREATE TABLE kv (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- Standing rules: download every show on this channel whose title matches.
-- title_contains must all appear in the title and title_excludes must not
-- (JSON arrays, case insensitive). from_date skips shows that finished before
-- it. overrides is the JSON plan overrides, anything unset follows settings.
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  channel TEXT NOT NULL,
  title_contains TEXT NOT NULL DEFAULT '[]',
  title_excludes TEXT NOT NULL DEFAULT '[]',
  from_date TEXT,
  overrides TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- One off recordings picked from the guide before they aired. They record the
-- time slot that was picked, once it has passed. The program columns are the
-- guide entry as it looked when it was scheduled; the guide isn't read again.
-- status is pending, done or expired (still failing 48 hours after the slot).
CREATE TABLE scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  start_local TEXT NOT NULL,
  end_local TEXT NOT NULL,
  overrides TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  output_path TEXT
);
CREATE INDEX scheduled_status ON scheduled (status);

-- Every piece of background work. kind is check, download or comskip.
-- trigger is manual (someone pressed a button), scheduled (the timer) or
-- automatic (queued by another job). status is queued, running, succeeded,
-- failed, cancelled or interrupted (the server stopped while it was queued or
-- running). title and link are snapshots so history reads well later. step,
-- done and total are the live progress. params is what the runner needs.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  title TEXT NOT NULL,
  link TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  step TEXT,
  done INTEGER,
  total INTEGER,
  summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX jobs_status ON jobs (status);

-- What a job did, line by line. level is info, warn or error.
CREATE TABLE job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX job_logs_job ON job_logs (job_id);
