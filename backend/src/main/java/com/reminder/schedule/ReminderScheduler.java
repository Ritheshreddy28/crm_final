package com.reminder.schedule;

import com.reminder.dto.ReminderJobType;
import com.reminder.service.ReminderJobService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class ReminderScheduler {

    private static final Logger log = LoggerFactory.getLogger(ReminderScheduler.class);

    private final ReminderJobService reminderJobService;

    public ReminderScheduler(ReminderJobService reminderJobService) {
        this.reminderJobService = reminderJobService;
    }

    @Scheduled(cron = "${reminder.cron}")
    public void runDailyReminders() {
        try {
            reminderJobService.runReminderJob(ReminderJobType.ALL);
        } catch (Exception e) {
            log.error("[reminder] Job error: {}", e.getMessage());
        }
    }
}
