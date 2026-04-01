package com.reminder.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;

import java.math.BigDecimal;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record DelayedFuturePaymentRow(
        String email,
        String recipientName,
        String paymentDate,
        String senderName,
        String category,
        String customCategory,
        BigDecimal amount,
        String currency
) {
}
