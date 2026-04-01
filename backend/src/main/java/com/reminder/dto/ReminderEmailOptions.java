package com.reminder.dto;

public record ReminderEmailOptions(
        String subject,
        String title,
        String intro,
        String footer,
        String secondColumnHeader
) {
    public static ReminderEmailOptions studentDefaults() {
        return new ReminderEmailOptions(null, null, null, null, null);
    }

    public static ReminderEmailOptions delayedFutureDefaults() {
        return new ReminderEmailOptions(
                "⏰ Delayed future repayment reminder",
                "Delayed future repayment reminder",
                "You have the following delayed (overdue) future repayment(s) (pending until marked done):",
                "This reminder will be sent until the payment is marked as done.",
                "Category"
        );
    }
}
