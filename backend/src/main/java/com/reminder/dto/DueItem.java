package com.reminder.dto;

import java.math.BigDecimal;

public record DueItem(String dueDate, String senderName, BigDecimal amount, String currency) {
}
