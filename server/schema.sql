-- SAT practice VPS backend — schema (multi-user version).
-- Run once:  psql "$DATABASE_URL" -f schema.sql

-- Identity: typed name + PIN (plain text, collision protection only — NOT real security).
CREATE TABLE IF NOT EXISTS users (
  name       TEXT PRIMARY KEY,
  pin        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Undirected friendships stored as two directed rows (A->B and B->A).
-- Empty friends table = closed group mode: presence/history broadcast to everyone.
CREATE TABLE IF NOT EXISTS friends (
  user_name   TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  friend_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_name, friend_name),
  CHECK (user_name <> friend_name)
);
CREATE INDEX IF NOT EXISTS friends_user_idx ON friends(user_name);

-- Presence / today's counter (one row per player).
CREATE TABLE IF NOT EXISTS status (
  name          TEXT PRIMARY KEY REFERENCES users(name) ON DELETE CASCADE,
  current_index INT NOT NULL DEFAULT 0,
  last_seen     BIGINT NOT NULL DEFAULT 0,   -- unix ms; 0 = explicitly offline
  day_key       TEXT NOT NULL DEFAULT '',
  today_count   INT NOT NULL DEFAULT 0
);

-- Append-only answer ledger. Source of truth for progress and history.
CREATE TABLE IF NOT EXISTS attempts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_name   TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  selected    CHAR(1) NOT NULL CHECK (selected IN ('A','B','C','D')),
  is_correct  BOOLEAN NOT NULL,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id  TEXT NULL
);
CREATE INDEX IF NOT EXISTS attempts_user_q_idx ON attempts(user_name, question_id, answered_at DESC);
CREATE INDEX IF NOT EXISTS attempts_answered_idx ON attempts(answered_at DESC);

-- Live 1v1 challenges (duels). Chat is ephemeral (socket-only, never stored).
-- current_answers: { "<name>": {user_name, questionIndex, selected, is_correct, timeMs} }
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host            TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  guest           TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  total_questions INT NOT NULL CHECK (total_questions BETWEEN 1 AND 100),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','finished','expired','declined','forfeited')),
  current_index   INT NOT NULL DEFAULT 0,
  question_ids    TEXT[] NOT NULL DEFAULT '{}',
  current_answers JSONB NOT NULL DEFAULT '{}',
  created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT, -- unix ms
  started_at      TIMESTAMPTZ NULL,
  finished_at     TIMESTAMPTZ NULL,
  forfeited_by    TEXT NULL,
  players         TEXT[] NULL,
  accepted_by     TEXT[] NULL,
  forfeited_players TEXT[] NULL,
  mode            TEXT NOT NULL DEFAULT 'wait' CHECK (mode IN ('wait', 'rush')),
  rush_answers    JSONB NOT NULL DEFAULT '{}',
  finished_players TEXT[] NOT NULL DEFAULT '{}',
  player_times    JSONB NOT NULL DEFAULT '{}',
  CHECK (host <> guest)
);
CREATE INDEX IF NOT EXISTS sessions_guest_status_idx ON sessions(guest, status, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_host_status_idx ON sessions(host, status, created_at DESC);

-- Teacher & Student Homework System
CREATE TABLE IF NOT EXISTS classes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  join_code  TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS class_members (
  class_id   UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_name  TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, user_name)
);
CREATE INDEX IF NOT EXISTS class_members_user_idx ON class_members(user_name);

CREATE TABLE IF NOT EXISTS assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id     UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  question_ids TEXT[] NOT NULL DEFAULT '{}',
  due_at       TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignments_class_idx ON assignments(class_id, created_at DESC);

CREATE TABLE IF NOT EXISTS homework_submissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id  UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_name      TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
  attempt_number INT NOT NULL DEFAULT 1,
  answers        JSONB NOT NULL DEFAULT '{}',
  score          INT NOT NULL DEFAULT 0,
  total          INT NOT NULL DEFAULT 0,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_late        BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS hw_subs_assign_user_idx ON homework_submissions(assignment_id, user_name, attempt_number DESC);

-- Tables are created by the postgres superuser; the app role needs full access
-- (and to any tables created later, e.g. by future migrations).
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO waleed;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO waleed;
