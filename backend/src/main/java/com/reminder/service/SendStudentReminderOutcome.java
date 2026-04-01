package com.reminder.service;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.Map;

public final class SendStudentReminderOutcome {

    private final boolean success;
    private final HttpStatus status;
    private final String errorMessage;

    private SendStudentReminderOutcome(boolean success, HttpStatus status, String errorMessage) {
        this.success = success;
        this.status = status;
        this.errorMessage = errorMessage;
    }

    public static SendStudentReminderOutcome ok() {
        return new SendStudentReminderOutcome(true, HttpStatus.OK, null);
    }

    public static SendStudentReminderOutcome notFound(String message) {
        return new SendStudentReminderOutcome(false, HttpStatus.NOT_FOUND, message);
    }

    public static SendStudentReminderOutcome badRequest(String message) {
        return new SendStudentReminderOutcome(false, HttpStatus.BAD_REQUEST, message);
    }

    public static SendStudentReminderOutcome serverError(String message) {
        return new SendStudentReminderOutcome(false, HttpStatus.INTERNAL_SERVER_ERROR, message);
    }

    public boolean isSuccess() {
        return success;
    }

    public ResponseEntity<?> toResponse() {
        if (success) {
            return ResponseEntity.ok(Map.of("ok", true));
        }
        return ResponseEntity.status(status).body(Map.of("error", errorMessage));
    }
}
