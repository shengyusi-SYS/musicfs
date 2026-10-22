-- User-configured WebDAV credentials override the initial deployment secrets.
CREATE TABLE IF NOT EXISTS dav_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password TEXT NOT NULL
);
