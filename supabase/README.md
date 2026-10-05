# Supabase migration — operational notes

## Architecture

```
Browser  ──►  Express server  ──►  Supabase Postgres   (all data)
   │                  │
   │                  └──►  Firebase Auth          (identity only)
   ▼
Firebase Auth issues the ID token; the server verifies it, then reads/writes
the user profile from the `users` table.
```

Firebase is no longer a datastore. Neither Firestore nor the Realtime Database
is used. They remain only as the untouched rollback copy of your data.

## Why this was needed

Firestore on the Spark (free) plan allows 50,000 document reads per day. The app
reads on nearly every page load (dashboard, inventory, sales, reports), so
login began failing with `RESOURCE_EXHAUSTED: Quota exceeded` at the user-profile
lookup in `routes/auth.js`. Postgres has no comparable per-read metering, so the
same workload sits comfortably inside the Supabase free tier (500 MB database).

## Storage strategy

Current dataset is tiny (roughly 17 products, 14 businesses, tens of documents),
so storage is not a real constraint. The schema is still built to last:

- **Every document is preserved.** Each row keeps the complete document in a
  `data jsonb` column, so no field is dropped, renamed, or coerced. Firestore's
  types round-trip exactly: numerics stay numbers, booleans stay booleans,
  arrays (`sales.items`) and nested blobs (`backupsData.backup`) survive intact.
- **Real columns only where you query.** The fields used in `WHERE` and
  `ORDER BY` are mirrored into typed columns with indexes, so filtering and
  sorting behave identically to Firestore.
- **`text`, never `varchar(n)`,** so no length limit can silently truncate data.
- **ISO-8601 timestamps stay `text`,** preserving the exact string your report
  code already parses with no timezone reinterpretation.
- **Nothing is pruned.** `audit_logs` and `backups_data` are the largest
  consumers and are deliberately kept in full.

## Security model

`ROW LEVEL SECURITY` is enabled on all 19 tables with zero policies.

- The server uses the **service-role key**, which bypasses RLS — the direct
  equivalent of the Firebase Admin SDK bypassing Firestore rules.
- The **anon key** is public and served at `/api/supabase-config`, but because
  no policies exist it can read nothing. Verified by
  `scripts/test-datalayer.js`.

Rotate the service-role key if it was ever pasted into a chat, a commit, or a
screenshot: Supabase → Project Settings → API Keys → Reset.

## Rollback

Set `DB_PROVIDER=firestore` and restart. The 9 exported functions in
`config/db.js` have identical signatures on both backends, so no application
code changes. Firestore still holds the original data, untouched.