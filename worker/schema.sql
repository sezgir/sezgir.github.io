-- one row per player per daily puzzle
CREATE TABLE IF NOT EXISTS plays (
  date    TEXT    NOT NULL,          -- YYYY-MM-DD of the puzzle
  client  TEXT    NOT NULL,          -- random id kept in the player's browser
  total   INTEGER NOT NULL,          -- 0..100
  scores  TEXT    NOT NULL,          -- JSON array of the five test scores
  created INTEGER NOT NULL,          -- unix ms
  PRIMARY KEY (date, client)
);
CREATE INDEX IF NOT EXISTS plays_date_total ON plays (date, total);
CREATE INDEX IF NOT EXISTS plays_client ON plays (client, date);

-- one row per visitor per day; `last` is refreshed by a ping every couple of minutes while the page is open
CREATE TABLE IF NOT EXISTS visits (
  date   TEXT    NOT NULL,           -- YYYY-MM-DD in Asia/Tashkent
  client TEXT    NOT NULL,
  last   INTEGER NOT NULL,           -- unix ms of the latest ping
  PRIMARY KEY (date, client)
);
CREATE INDEX IF NOT EXISTS visits_last ON visits (last);
CREATE INDEX IF NOT EXISTS visits_client ON visits (client);

-- Telegram bot subscribers (daily reminders)
CREATE TABLE IF NOT EXISTS tg_users (
  chat_id INTEGER PRIMARY KEY,
  client  TEXT,                      -- player id the reminders and streak are tied to
  name    TEXT,
  active  INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  asked   INTEGER NOT NULL DEFAULT 0 -- 1 once the one-time support message was sent (older DBs: ALTER TABLE ... ADD COLUMN)
);

-- Telegram groups with a shared daily leaderboard
CREATE TABLE IF NOT EXISTS tg_groups (
  chat_id INTEGER PRIMARY KEY,       -- negative Telegram group id
  title   TEXT,
  active  INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_members (
  group_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,         -- = tg_users.chat_id (private chat id)
  joined   INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS tg_members_user ON tg_members (user_id);

-- Telegram Stars donations ("Qo'llab-quvvatlash")
CREATE TABLE IF NOT EXISTS donations (
  charge_id TEXT PRIMARY KEY,        -- telegram_payment_charge_id
  chat_id   INTEGER NOT NULL,        -- payer's Telegram user id
  name      TEXT,
  stars     INTEGER NOT NULL,
  anon      INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS donations_chat ON donations (chat_id);


-- running counters so hot paths never scan whole tables:
-- players / visitors (all time), v:<date> visitors that day, p:<date> plays that day, s:<date> sum of totals that day
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);
-- short-lived cached JSON (stats of a day, live, summary), refreshed every 30-120 s
CREATE TABLE IF NOT EXISTS snap (
  k    TEXT PRIMARY KEY,
  at   INTEGER NOT NULL,
  data TEXT NOT NULL
);

-- other device ids of the same person (browser tab, second webview) -> the Telegram user's main id
CREATE TABLE IF NOT EXISTS aliases (
  alias  TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  at     INTEGER NOT NULL
);

-- duels: a challenges b inside group gid; both play the puzzle made from `seed`
CREATE TABLE IF NOT EXISTS duels (
  id TEXT PRIMARY KEY, gid INTEGER NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL, seed TEXT NOT NULL,
  status TEXT NOT NULL, day TEXT NOT NULL, created INTEGER NOT NULL, accepted INTEGER,
  a_start INTEGER, b_start INTEGER, a_score INTEGER, b_score INTEGER, a_scores TEXT, b_scores TEXT, delta INTEGER,
  nudged INTEGER NOT NULL DEFAULT 0,     -- reminder bits, see duelRemind
  card INTEGER NOT NULL DEFAULT 1        -- 0 = group result post still waiting for the app's picture
);
CREATE INDEX IF NOT EXISTS duels_pair ON duels (day, a, b);
CREATE INDEX IF NOT EXISTS duels_status ON duels (status, created);
-- duel rating (Elo, starts at 1000)
CREATE TABLE IF NOT EXISTS duel_elo (
  chat_id INTEGER PRIMARY KEY, elo INTEGER NOT NULL DEFAULT 1000, w INTEGER NOT NULL DEFAULT 0, l INTEGER NOT NULL DEFAULT 0, d INTEGER NOT NULL DEFAULT 0
);
-- ratings: one row per asked player; wait = time of rating while the bot waits for a comment
CREATE TABLE IF NOT EXISTS feedback (
  chat_id INTEGER PRIMARY KEY, name TEXT, username TEXT, stars INTEGER, comment TEXT,
  asked INTEGER NOT NULL, rated INTEGER, commented INTEGER, wait INTEGER NOT NULL DEFAULT 0, nudged INTEGER NOT NULL DEFAULT 0
);
-- other games (Chaqmoq /poyga/, Pistirma /pistirma/): one row per game, Tashkent day and player (also created lazily by the worker)
CREATE TABLE IF NOT EXISTS game_plays (
  game TEXT NOT NULL, date TEXT NOT NULL, client TEXT NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0, finishes INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
  best REAL, PRIMARY KEY (game, date, client)
);
