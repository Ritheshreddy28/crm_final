package com.reminder.dto;

public enum ReminderJobType {
    STUDENTS,
    FUTURE,
    ALL;

    public static ReminderJobType fromBody(String raw) {
        if (raw == null) {
            return ALL;
        }
        return switch (raw) {
            case "students" -> STUDENTS;
            case "future" -> FUTURE;
            default -> ALL;
        };
    }
}
