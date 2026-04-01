package com.reminder.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "reminder")
public class ReminderProperties {

    /**
     * Spring cron: second minute hour day month weekday — 9:00 daily.
     */
    private String cron = "0 0 9 * * ?";

    public String getCron() {
        return cron;
    }

    public void setCron(String cron) {
        this.cron = cron;
    }
}
