/** Better Auth 1.7 core models. Shared by desktop auth.sqlite and the D1 migration. */
export const MANAGEMENT_AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS management_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);
CREATE TABLE IF NOT EXISTS management_session (
  id TEXT PRIMARY KEY NOT NULL,
  expiresAt DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES management_user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS management_session_userId_idx ON management_session(userId);
CREATE TABLE IF NOT EXISTS management_account (
  id TEXT PRIMARY KEY NOT NULL,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES management_user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt DATE,
  refreshTokenExpiresAt DATE,
  scope TEXT,
  password TEXT,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS management_account_userId_idx ON management_account(userId);
CREATE TABLE IF NOT EXISTS management_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt DATE NOT NULL,
  createdAt DATE NOT NULL,
  updatedAt DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS management_verification_identifier_idx ON management_verification(identifier);
`;
