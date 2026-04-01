/**
 * =============================================================================
 * HOW THE FRONTEND CONNECTS TO BACKENDS (whole project)
 * =============================================================================
 *
 * (1) SUPABASE — default for almost every screen and button
 *     - Import: `import { supabase } from './supabase'` (or `'../lib/supabase'`).
 *     - The client calls your Supabase project over HTTPS, using:
 *         • VITE_SUPABASE_URL  → host like `https://xxxx.supabase.co`
 *         • VITE_SUPABASE_ANON_KEY → public anon key
 *     - Typical paths (handled by the SDK, not written manually):
 *         • REST:   `{url}/rest/v1/...`  (tables, RPCs)
 *         • Auth:   `{url}/auth/v1/...`  (login, session)
 *         • Storage:`{url}/storage/v1/...` (uploads, signed URLs)
 *
 * (2) SPRING / NODE REMINDER API — only admin “send reminder” actions
 *     - Env: VITE_REMINDER_API_URL = origin only, e.g. `https://your-java-server.com`
 *     - Full URLs: see REMINDER_API_URLS below (`/api/send-reminders`, etc.).
 *
 * (3) OPENAI / OPENROUTER — optional AI vision on payment screenshots
 *     - Env: VITE_OPENAI_API_KEY
 *     - Code picks URL: OpenAI or OpenRouter (see VISION_CHAT_URLS).
 *
 * (4) `fetch(signedUrl)` for images — signed URLs come from Supabase Storage
 *     (same Supabase project as (1)); no extra env.
 *
 * =============================================================================
 */

export const BACKEND_ENV = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  reminderApiBase: (import.meta.env.VITE_REMINDER_API_URL ?? '').trim().replace(/\/+$/, ''),
  openAiApiKey: import.meta.env.VITE_OPENAI_API_KEY as string | undefined,
} as const;

/** Vision chat completions: chosen at runtime based on key prefix in visionExtract.ts */
export const VISION_CHAT_URLS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  openRouter: 'https://openrouter.ai/api/v1/chat/completions',
} as const;

const reminderBase = BACKEND_ENV.reminderApiBase;

export const REMINDER_API_URLS = {
  /** Configured API origin (no trailing slash), or empty if not set. */
  base: reminderBase,
  /** POST — Bearer = Supabase session token; body `{ type: 'all' | 'students' | 'future' }` */
  sendReminders: reminderBase ? `${reminderBase}/api/send-reminders` : '',
  /** POST — same auth; body `{ student_id: string }` */
  sendReminderToStudent: reminderBase ? `${reminderBase}/api/send-reminder-to-student` : '',
} as const;

export function isReminderApiConfigured(): boolean {
  return reminderBase.length > 0;
}

/** True when the browser blocked or could not complete the request (wrong host, offline, CORS, mixed content, etc.). */
export function isReminderFetchNetworkError(e: unknown): boolean {
  if (e instanceof TypeError && typeof e.message === 'string' && e.message.toLowerCase().includes('fetch')) {
    return true;
  }
  return e instanceof Error && e.message === 'Failed to fetch';
}

/**
 * Shown next to reminder buttons when fetch fails. Vite sets import.meta.env.PROD on Vercel builds.
 */
export function reminderApiNetworkErrorHint(): string {
  if (import.meta.env.DEV) {
    return 'Cannot reach reminder API. Set VITE_REMINDER_API_URL (e.g. http://localhost:3001) and run server-spring or server.';
  }
  return (
    'Cannot reach reminder API. It is not on Vercel — deploy server-spring or server (Render, Railway, etc.), ' +
    'set VITE_REMINDER_API_URL to that https URL in Vercel → Environment Variables, then Redeploy. Do not use localhost.'
  );
}
