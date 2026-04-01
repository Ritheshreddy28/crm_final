package com.reminder.dto;

import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonNaming;

import java.math.BigDecimal;

@JsonNaming(PropertyNamingStrategies.SnakeCaseStrategy.class)
public record StudentPaymentRow(
        String subjects,
        String paymentStatus,
        BigDecimal balanceAmount,
        String currency
) {
}
