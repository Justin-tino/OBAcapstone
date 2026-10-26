# Deploying the OBA System on Render

This repository includes a [Render Blueprint](https://render.com/docs/blueprint-spec)
(`render.yaml`). Render reads it automatically when you connect the repository.

## 1. Create the service

1. Push this repository to GitHub.
2. In the Render Dashboard, choose **New → Blueprint**.
3. Connect the repository and branch (`main`).
4. Render detects `render.yaml` and creates the `oba-psau` web service.
5. Click **Apply**.

Render automatically provides `PORT`, sets up HTTPS, and uses `/healthz` as the
health check. The service binds to `0.0.0.0` and is reachable on the public URL
Render assigns.

## 2. Fill in the environment variables

`render.yaml` marks passwords and keys as `sync: false`. Enter their values in
**Dashboard → oba-psau → Environment**:

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | auto-generated | Render generates a secure value. |
| `SUPABASE_URL` | yes | Supabase project URL. |
| `SUPABASE_ANON_KEY` | yes | Public `sb_publishable_…` key. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only `sb_secret_…` key. Never expose it. |
| `FIREBASE_PROJECT_ID` | yes | Firebase identity project. |
| `FIREBASE_PRIVATE_KEY_ID` | yes | Service-account value. |
| `FIREBASE_PRIVATE_KEY` | yes | Paste the full `-----BEGIN PRIVATE KEY-----` value. Escaped `\n` characters are supported. |
| `FIREBASE_CLIENT_EMAIL` | yes | Service-account value. |
| `FIREBASE_CLIENT_ID` | yes | Service-account value. |
| `FIREBASE_API_KEY` | yes | Browser SDK value. |
| `FIREBASE_AUTH_DOMAIN` | yes | Browser SDK value. |
| `FIREBASE_STORAGE_BUCKET` | yes | Browser SDK value. |
| `FIREBASE_MESSAGING_SENDER_ID` | yes | Browser SDK value. |
| `FIREBASE_APP_ID` | yes | Browser SDK value. |
| `BREVO_API_KEY` | yes | Used for OTP and password-reset email. |
| `BREVO_SENDER_EMAIL` | yes | Must be verified in Brevo. |

`NODE_ENV=production`, `DB_PROVIDER=supabase`, the Firebase auth/token URIs, and
`MAIL_FROM_NAME` are already set in `render.yaml`.

Do **not** set `PORT` yourself on Render.

### Custom domain

Password-reset links use `APP_BASE_URL` when it is set. Otherwise they use
Render's automatically-provided `RENDER_EXTERNAL_URL`. Set `APP_BASE_URL` only
if you attach a custom domain:

```text
APP_BASE_URL=https://your-domain.example
```

## 3. Verify the deployment

- `https://<your-service>.onrender.com/healthz` should return
  `{"status":"ok", ...}`.
- Open `https://<your-service>.onrender.com/` and log in.
- Check **Logs** in Render for Supabase and Firebase connection messages.
- If Firebase credentials are missing, the app still starts but runs in demo/mock
  mode.

## Render plan notes

- **Free plan sleeps** after a period of inactivity. The first request afterwards
  may take several seconds (cold start).
- **Sessions are stored in memory.** A restart or free-plan wake logs users out.
  For stronger production behavior, use a persistent session store.
- **Daily automated backups** run inside the app. They only run while the service
  is awake; on the free plan, use Render Cron Jobs or an external scheduler to
  wake the service if backups must run exactly every day.
- **Outbound SMTP is blocked.** Keep `BREVO_API_KEY` configured so email uses the
  Brevo HTTPS API instead of Gmail SMTP.
