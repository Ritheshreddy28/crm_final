package com.reminder.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.reminder.config.SupabaseProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

@Service
public class AdminAuthService {

    private static final Logger log = LoggerFactory.getLogger(AdminAuthService.class);

    private final WebClient webClient;
    private final SupabaseProperties supabase;

    public AdminAuthService(WebClient webClient, SupabaseProperties supabase) {
        this.webClient = webClient;
        this.supabase = supabase;
    }

    public boolean isAdmin(String bearerToken) {
        if (!supabase.isConfiguredForAuth()) {
            log.error("[reminder] SUPABASE_URL or SUPABASE_ANON_KEY not set");
            return false;
        }
        if (bearerToken == null || bearerToken.isBlank()) {
            return false;
        }
        String base = supabase.baseUrl();
        try {
            JsonNode user = webClient.get()
                    .uri(base + "/auth/v1/user")
                    .header("Authorization", "Bearer " + bearerToken.trim())
                    .header("apikey", supabase.getAnonKey().trim())
                    .retrieve()
                    .bodyToMono(JsonNode.class)
                    .block();
            if (user == null || user.isNull()) {
                return false;
            }
            String role = extractRole(user);
            if ("admin".equals(role)) {
                return true;
            }
            log.error("[reminder] User not admin; role: {}", role == null ? "none" : role);
            return false;
        } catch (WebClientResponseException e) {
            log.error("[reminder] getUser failed: {}", e.getMessage());
            return false;
        }
    }

    private static String extractRole(JsonNode user) {
        String[] metaPaths = {"app_metadata", "user_metadata", "raw_app_meta_data", "raw_user_meta_data"};
        for (String path : metaPaths) {
            if (user.has(path) && user.get(path).isObject()) {
                JsonNode meta = user.get(path);
                if (meta.has("role") && meta.get("role").isTextual()) {
                    return meta.get("role").asText();
                }
            }
        }
        return null;
    }
}
