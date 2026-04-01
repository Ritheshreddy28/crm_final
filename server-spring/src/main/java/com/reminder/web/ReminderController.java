package com.reminder.web;

import com.reminder.dto.ReminderJobResult;
import com.reminder.dto.ReminderJobType;
import com.reminder.service.AdminAuthService;
import com.reminder.service.ReminderJobService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
public class ReminderController {

    private static final Logger log = LoggerFactory.getLogger(ReminderController.class);

    private final AdminAuthService adminAuth;
    private final ReminderJobService reminderJobService;

    public ReminderController(AdminAuthService adminAuth, ReminderJobService reminderJobService) {
        this.adminAuth = adminAuth;
        this.reminderJobService = reminderJobService;
    }

    @PostMapping(ReminderApiPaths.SEND_REMINDERS)
    public ResponseEntity<?> sendReminders(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody(required = false) Map<String, Object> body
    ) {
        String token = bearer(authorization);
        if (token.isEmpty()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "Missing token"));
        }
        if (!adminAuth.isAdmin(token)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", "Admin only"));
        }
        String typeRaw = body != null && body.get("type") instanceof String ? (String) body.get("type") : null;
        ReminderJobType type = ReminderJobType.fromBody(typeRaw);
        String typeLabel = switch (type) {
            case STUDENTS -> "students";
            case FUTURE -> "future";
            case ALL -> "all";
        };
        try {
            ReminderJobResult result = reminderJobService.runReminderJob(type);
            return ResponseEntity.ok(Map.of(
                    "ok", true,
                    "sent", result.sent(),
                    "failed", result.failed(),
                    "type", typeLabel
            ));
        } catch (Exception e) {
            log.error("[reminder] API error: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", "Reminder job failed"));
        }
    }

    @PostMapping(ReminderApiPaths.SEND_REMINDER_TO_STUDENT)
    public ResponseEntity<?> sendReminderToStudent(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @RequestBody(required = false) Map<String, Object> body
    ) {
        String token = bearer(authorization);
        if (token.isEmpty()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "Missing token"));
        }
        if (!adminAuth.isAdmin(token)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", "Admin only"));
        }
        String studentId = body != null && body.get("student_id") instanceof String ? (String) body.get("student_id") : null;
        if (studentId == null || studentId.isBlank()) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("error", "student_id required"));
        }
        try {
            return reminderJobService.sendReminderToStudent(studentId.trim()).toResponse();
        } catch (Exception e) {
            log.error("[reminder] send-to-student error: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", "Failed to send reminder"));
        }
    }

    private static String bearer(String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            return "";
        }
        return authorization.substring(7).trim();
    }
}
