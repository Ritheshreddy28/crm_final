package com.reminder.service;

import com.reminder.config.SupabaseProperties;
import com.reminder.dto.DelayedFuturePaymentRow;
import com.reminder.dto.StudentPaymentRow;
import com.reminder.dto.StudentRecordRow;
import com.reminder.dto.StudentReminderRow;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.Collections;
import java.util.List;

@Component
public class SupabaseRestClient {

    private static final Logger log = LoggerFactory.getLogger(SupabaseRestClient.class);

    private final WebClient webClient;
    private final SupabaseProperties supabase;

    public SupabaseRestClient(WebClient webClient, SupabaseProperties supabase) {
        this.webClient = webClient;
        this.supabase = supabase;
    }

    public List<StudentReminderRow> rpcStudentReminderRecipients() {
        return rpc("get_student_reminder_recipients", new ParameterizedTypeReference<List<StudentReminderRow>>() {
        });
    }

    public List<DelayedFuturePaymentRow> rpcDelayedFuturePaymentReminders() {
        return rpc("get_delayed_future_payment_reminders", new ParameterizedTypeReference<List<DelayedFuturePaymentRow>>() {
        });
    }

    private <T> List<T> rpc(String functionName, ParameterizedTypeReference<List<T>> typeRef) {
        if (!supabase.isConfiguredForService()) {
            return Collections.emptyList();
        }
        String base = supabase.baseUrl();
        String key = supabase.getServiceRoleKey().trim();
        try {
            List<T> body = webClient.post()
                    .uri(base + "/rest/v1/rpc/" + functionName)
                    .header("apikey", key)
                    .header("Authorization", "Bearer " + key)
                    .header("Content-Type", "application/json")
                    .bodyValue("{}")
                    .retrieve()
                    .bodyToMono(typeRef)
                    .block();
            return body != null ? body : Collections.emptyList();
        } catch (WebClientResponseException e) {
            log.error("[reminder] RPC {} error: {}", functionName, e.getMessage());
            return Collections.emptyList();
        }
    }

    public StudentRecordRow fetchStudent(String studentId) {
        if (!supabase.isConfiguredForService()) {
            return null;
        }
        String base = supabase.baseUrl();
        String key = supabase.getServiceRoleKey().trim();
        String uri = UriComponentsBuilder.fromUriString(base + "/rest/v1/student_records")
                .queryParam("select", "id,email,student_name,subjects")
                .queryParam("id", "eq." + studentId)
                .build(true)
                .toUriString();
        try {
            List<StudentRecordRow> rows = webClient.get()
                    .uri(uri)
                    .header("apikey", key)
                    .header("Authorization", "Bearer " + key)
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<List<StudentRecordRow>>() {
                    })
                    .block();
            if (rows == null || rows.isEmpty()) {
                return null;
            }
            return rows.get(0);
        } catch (WebClientResponseException e) {
            log.error("[reminder] fetchStudent error: {}", e.getMessage());
            return null;
        }
    }

    public List<StudentPaymentRow> fetchUnpaidPaymentsForStudent(String studentId) {
        if (!supabase.isConfiguredForService()) {
            return Collections.emptyList();
        }
        String base = supabase.baseUrl();
        String key = supabase.getServiceRoleKey().trim();
        String uri = UriComponentsBuilder.fromUriString(base + "/rest/v1/student_payments")
                .queryParam("select", "subjects,payment_status,balance_amount,currency")
                .queryParam("student_id", "eq." + studentId)
                .queryParam("balance_amount", "gt.0")
                .queryParam("payment_status", "in.(unpaid,paid_partially)")
                .build(true)
                .toUriString();
        try {
            List<StudentPaymentRow> rows = webClient.get()
                    .uri(uri)
                    .header("apikey", key)
                    .header("Authorization", "Bearer " + key)
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<List<StudentPaymentRow>>() {
                    })
                    .block();
            return rows != null ? rows : Collections.emptyList();
        } catch (WebClientResponseException e) {
            log.error("[reminder] fetchUnpaidPaymentsForStudent error: {}", e.getMessage());
            return Collections.emptyList();
        }
    }
}
