package com.reminder.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Supabase credentials for this Spring service (same env names as the Node {@code server/}
 * and the same values as the React app uses for {@code VITE_SUPABASE_URL} /
 * {@code VITE_SUPABASE_ANON_KEY}, plus the service role key which is server-only).
 */
@ConfigurationProperties(prefix = "supabase")
public class SupabaseProperties {

    private String url = "";
    private String anonKey = "";
    private String serviceRoleKey = "";

    public String baseUrl() {
        if (url == null || url.isBlank()) {
            return "";
        }
        return url.replaceAll("/+$", "");
    }

    public String getUrl() {
        return url;
    }

    public void setUrl(String url) {
        this.url = url;
    }

    public String getAnonKey() {
        return anonKey;
    }

    public void setAnonKey(String anonKey) {
        this.anonKey = anonKey;
    }

    public String getServiceRoleKey() {
        return serviceRoleKey;
    }

    public void setServiceRoleKey(String serviceRoleKey) {
        this.serviceRoleKey = serviceRoleKey;
    }

    public boolean isConfiguredForService() {
        return !baseUrl().isBlank() && serviceRoleKey != null && !serviceRoleKey.isBlank();
    }

    public boolean isConfiguredForAuth() {
        return !baseUrl().isBlank() && anonKey != null && !anonKey.isBlank();
    }
}
