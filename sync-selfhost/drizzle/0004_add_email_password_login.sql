ALTER TABLE users ADD COLUMN password_hash TEXT;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN password_salt TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_unique_ci ON users(lower(email));
