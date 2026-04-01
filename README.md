# CRM Payment Management System

Full-stack payment management app with:

- React + TypeScript frontend (Vite)
- Supabase for auth, database, storage, and RPCs
- Reminder email backend (Spring Boot in `server-spring/`, with optional Node backend in `server/`)

## Current Deployment Status

- Frontend: deployed on Vercel
- Reminder API backend: deployed on Render at:
  - `https://payment-reminder-api-st2.onrender.com`
- Integration goal:
  - Frontend uses `VITE_REMINDER_API_URL` to call the Render backend for reminder actions
  - Frontend uses Supabase directly for core app data/auth

## Project Structure

- `src/` - React frontend pages, components, and libs
  - `src/lib/supabase.ts` - Supabase client initialization
  - `src/lib/backendConfig.ts` - centralized backend/env URL config
  - `src/pages/AdminDashboard.tsx` - reminder button API calls
- `supabase/migrations/` - SQL migrations (tables, RLS policies, RPCs)
- `server-spring/` - Java Spring Boot reminder backend (recommended)
- `server/` - Node/Express reminder backend (alternative implementation)
- `render.yaml` - Render Blueprint config for backend deployment
- `setup_admin.sql` - helper SQL to promote a user to admin role

## Architecture

### 1) Frontend -> Supabase (main app functions)

Most features (auth, CRUD, storage, dashboards) use Supabase directly from the browser:

- Auth: sign in/sign up/session
- Database: table reads/writes
- Storage: screenshot uploads and signed URLs
- RPC: helper SQL functions for search/merge/reminder data

Required frontend env:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### 2) Frontend -> Reminder API (email reminder actions only)

Admin reminder buttons call:

- `POST /api/send-reminders`
- `POST /api/send-reminder-to-student`

These routes are served by Spring backend (`server-spring`) and protected by Bearer token + admin role checks.

Required frontend env:

- `VITE_REMINDER_API_URL` (origin only, no trailing slash)

Example:

- `VITE_REMINDER_API_URL=https://payment-reminder-api-st2.onrender.com`

### 3) Reminder API -> Supabase + Gmail

Reminder backend uses:

- Supabase anon key to validate user token and role
- Supabase service role key for secure server-side RPC/data access
- Gmail SMTP for sending reminder emails

## Local Development

## Prerequisites

- Node.js 18+ (recommended)
- npm
- Java 17+ (for Spring backend)
- Maven 3.9+ (for Spring backend)

### Frontend

From project root:

```bash
npm install
npm run dev
```

Frontend env file (`.env`) should include:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_REMINDER_API_URL=http://localhost:3001
VITE_OPENAI_API_KEY=...   # optional
```

### Spring reminder backend (`server-spring`)

From `server-spring/`:

```bash
mvn -DskipTests compile
mvn spring-boot:run
```

Server listens on `PORT` (default `3001`).

Spring backend env (local shell or deploy platform):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GMAIL_USER`
- `GMAIL_APP_PASS`
- `PORT` (optional)
- `REMINDER_CRON` (optional)

## Render Deployment (Spring backend)

This repo includes:

- `server-spring/Dockerfile`
- `server-spring/.dockerignore`
- root `render.yaml`

Render setup:

1. Create a Render Web Service (or Blueprint) from this repo.
2. Use Docker build with:
   - Dockerfile path: `server-spring/Dockerfile`
   - Build context: `server-spring`
3. Set environment variables in Render:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GMAIL_USER`
   - `GMAIL_APP_PASS`
4. Deploy and verify service URL is live.

Health check recommendation:

- `GET /` should return success JSON (used to confirm app is alive).

## Vercel Deployment (Frontend)

In Vercel project settings, set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_REMINDER_API_URL` = Render backend origin
- `VITE_OPENAI_API_KEY` (optional)

After any env change, trigger a **Redeploy**.

## Database Setup (Supabase SQL Editor)

When switching to a new Supabase project:

1. Open SQL Editor.
2. Run all files from `supabase/migrations/` in ascending timestamp order.
3. Confirm required RPCs exist (for reminder and partial-pay flow).

## Admin Account Setup

1. Sign up a user via app auth.
2. In Supabase SQL Editor, set role metadata:

```sql
UPDATE auth.users
SET
  raw_app_meta_data  = COALESCE(raw_app_meta_data, '{}'::jsonb)  || '{"role":"admin"}'::jsonb,
  raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
WHERE email = 'your-admin-email@example.com';
```

3. Log out and log back in to refresh JWT claims.

## Security Notes

- Do not commit secrets (`.env` is gitignored).
- Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend (`VITE_*`).
- Rotate keys immediately if leaked.
- Use Gmail App Password, not raw account password.

## Troubleshooting

### Reminder button says API is unreachable

Check:

1. Render backend is actually live and reachable.
2. `VITE_REMINDER_API_URL` points to the correct Render URL (no trailing slash).
3. Vercel redeployed after env update.
4. Render env vars are configured.
5. User is admin (metadata role) and has fresh session token.

### Data loads but reminder send fails

- Usually backend env missing (`SUPABASE_SERVICE_ROLE_KEY` or Gmail vars).
- Check Render logs for exact error.

## Notes

- Primary production path: React frontend + Supabase + Spring reminder service on Render.
- Node backend in `server/` is retained as an alternative implementation.
