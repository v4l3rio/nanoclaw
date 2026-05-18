CREATE TABLE IF NOT EXISTS exercises (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  aliases       TEXT NOT NULL DEFAULT '[]',
  muscle_group  TEXT,
  equipment     TEXT,
  is_compound   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS programs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  started_on       TEXT NOT NULL DEFAULT (date('now')),
  ended_on         TEXT,
  microcycle_weeks INTEGER NOT NULL DEFAULT 4,
  is_active        INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS program_days (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id  INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  day_name    TEXT NOT NULL,
  day_order   INTEGER NOT NULL DEFAULT 0,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS program_exercises (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  program_day_id        INTEGER NOT NULL REFERENCES program_days(id) ON DELETE CASCADE,
  exercise_id           INTEGER NOT NULL REFERENCES exercises(id),
  ex_order              INTEGER NOT NULL DEFAULT 0,
  target_sets           INTEGER,
  target_reps           TEXT,
  target_rpe            REAL,
  target_rest_s         INTEGER,
  progression_strategy  TEXT NOT NULL DEFAULT 'rpe-based',
  notes                 TEXT
);

CREATE TABLE IF NOT EXISTS workouts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  program_day_id  INTEGER REFERENCES program_days(id),
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  bodyweight_kg   REAL,
  sleep_h         REAL,
  energy          INTEGER,
  session_note    TEXT
);

CREATE TABLE IF NOT EXISTS sets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id      INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id     INTEGER NOT NULL REFERENCES exercises(id),
  set_number      INTEGER NOT NULL,
  weight_kg       REAL NOT NULL,
  reps            INTEGER NOT NULL,
  rpe             REAL,
  rir             INTEGER,
  rest_s          INTEGER,
  note_post_set   TEXT,
  e1rm_kg         REAL,
  logged_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sets_exercise ON sets(exercise_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id);
CREATE INDEX IF NOT EXISTS idx_workouts_started ON workouts(started_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
