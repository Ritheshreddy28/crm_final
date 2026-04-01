package com.reminder.web;

/**
 * Public HTTP paths for this Spring Boot reminder API.
 * <p>
 * The React/Vite frontend should set environment variable {@code VITE_REMINDER_API_URL}
 * to this server's <strong>origin only</strong> (e.g. {@code https://your-host.com} or
 * {@code http://localhost:3001} with <strong>no</strong> trailing slash). It then calls:
 * </p>
 * <ul>
 *   <li>{@code VITE_REMINDER_API_URL + }{@link #SEND_REMINDERS} — POST, Bearer Supabase access token,
 *       JSON body {@code { "type": "all" | "students" | "future" }}</li>
 *   <li>{@code VITE_REMINDER_API_URL + }{@link #SEND_REMINDER_TO_STUDENT} — POST, same auth,
 *       JSON body {@code { "student_id": "&lt;uuid&gt;" }}</li>
 * </ul>
 * <p>
 * Other app features use Supabase directly from the browser ({@code VITE_SUPABASE_URL});
 * this service only handles scheduled and on-demand reminder emails (Gmail SMTP + Supabase RPC).
 * </p>
 */
public final class ReminderApiPaths {

    public static final String SEND_REMINDERS = "/api/send-reminders";
    public static final String SEND_REMINDER_TO_STUDENT = "/api/send-reminder-to-student";

    private ReminderApiPaths() {
    }
}
