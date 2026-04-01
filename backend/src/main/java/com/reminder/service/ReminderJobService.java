package com.reminder.service;

import com.reminder.config.SupabaseProperties;
import com.reminder.dto.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class ReminderJobService {

    private static final Logger log = LoggerFactory.getLogger(ReminderJobService.class);

    private final SupabaseProperties supabase;
    private final SupabaseRestClient supabaseRest;
    private final ReminderEmailService emailService;

    public ReminderJobService(SupabaseProperties supabase, SupabaseRestClient supabaseRest, ReminderEmailService emailService) {
        this.supabase = supabase;
        this.supabaseRest = supabaseRest;
        this.emailService = emailService;
    }

    public ReminderJobResult runReminderJob(ReminderJobType type) {
        int sent = 0;
        int failed = 0;

        if (!supabase.isConfiguredForService()) {
            log.error("[reminder] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
            return new ReminderJobResult(0, 0);
        }

        boolean runStudents = type == ReminderJobType.STUDENTS || type == ReminderJobType.ALL;
        boolean runFuture = type == ReminderJobType.FUTURE || type == ReminderJobType.ALL;

        if (runStudents) {
            List<StudentReminderRow> rows = supabaseRest.rpcStudentReminderRecipients();
            if (rows.isEmpty()) {
                log.debug("[reminder] No student reminder rows from RPC");
            }
            Map<String, List<DueItem>> byEmail = new LinkedHashMap<>();
            Map<String, String> nameByEmail = new LinkedHashMap<>();
            for (StudentReminderRow r : rows) {
                String email = trimOrNull(r.email());
                if (email == null) {
                    continue;
                }
                nameByEmail.putIfAbsent(email, trimOrElse(r.studentName(), email.split("@")[0]));
                String status = switch (coalesce(r.paymentStatus())) {
                    case "paid_partially" -> "Partially paid";
                    case "unpaid" -> "Unpaid";
                    default -> "Pending";
                };
                DueItem item = new DueItem(
                        status,
                        trimOrElse(r.subjects(), "—"),
                        r.balanceAmount(),
                        r.currency()
                );
                byEmail.computeIfAbsent(email, k -> new ArrayList<>()).add(item);
            }
            for (Map.Entry<String, List<DueItem>> e : byEmail.entrySet()) {
                String name = nameByEmail.getOrDefault(e.getKey(), e.getKey().split("@")[0]);
                try {
                    if (emailService.sendReminderEmail(e.getKey(), name, e.getValue(), ReminderEmailOptions.studentDefaults())) {
                        sent++;
                    } else {
                        failed++;
                    }
                } catch (Exception ex) {
                    failed++;
                }
            }
        }

        if (runFuture) {
            List<DelayedFuturePaymentRow> delayedList = supabaseRest.rpcDelayedFuturePaymentReminders();
            if (!delayedList.isEmpty()) {
                log.info("[reminder] Delayed future repayments: {} overdue row(s)", delayedList.size());
            }
            Map<String, List<DueItem>> futureByEmail = new LinkedHashMap<>();
            Map<String, String> futureNameByEmail = new LinkedHashMap<>();
            for (DelayedFuturePaymentRow r : delayedList) {
                String email = trimOrNull(r.email());
                if (email == null) {
                    continue;
                }
                String displayName = trimOrNull(r.recipientName());
                if (displayName == null) {
                    displayName = trimOrNull(r.senderName());
                }
                futureNameByEmail.putIfAbsent(email, displayName != null ? displayName : email.split("@")[0]);
                String displayCategory;
                if ("Other".equalsIgnoreCase(coalesce(r.category()))) {
                    displayCategory = trimOrElse(r.customCategory(), "Other");
                } else {
                    displayCategory = trimOrElse(
                            coalesce(r.category()),
                            trimOrElse(r.customCategory(), "Other")
                    );
                }
                DueItem item = new DueItem(
                        "Overdue",
                        displayCategory,
                        r.amount(),
                        r.currency()
                );
                futureByEmail.computeIfAbsent(email, k -> new ArrayList<>()).add(item);
            }
            int futureSentBefore = sent;
            ReminderEmailOptions delayedOpts = ReminderEmailOptions.delayedFutureDefaults();
            for (Map.Entry<String, List<DueItem>> e : futureByEmail.entrySet()) {
                String name = futureNameByEmail.getOrDefault(e.getKey(), e.getKey().split("@")[0]);
                try {
                    if (emailService.sendReminderEmail(e.getKey(), name, e.getValue(), delayedOpts)) {
                        sent++;
                    } else {
                        failed++;
                    }
                } catch (Exception ex) {
                    log.error("[reminder] Future repayment email failed for {}", e.getKey(), ex);
                    failed++;
                }
            }
            if (!futureByEmail.isEmpty()) {
                log.info("[reminder] Delayed future repayment emails: {} sent, {} recipient(s)",
                        sent - futureSentBefore, futureByEmail.size());
            }
        }

        if (sent > 0 || failed > 0) {
            log.info("[reminder] Total: Sent {}, Failed {}", sent, failed);
        }
        return new ReminderJobResult(sent, failed);
    }

    /**
     * @return null on success, or HTTP-style problem (status + JSON error message) for the controller.
     */
    public SendStudentReminderOutcome sendReminderToStudent(String studentId) {
        if (!supabase.isConfiguredForService()) {
            return SendStudentReminderOutcome.serverError("Server not configured");
        }
        StudentRecordRow student = supabaseRest.fetchStudent(studentId);
        if (student == null) {
            return SendStudentReminderOutcome.notFound("Student not found");
        }
        String email = trimOrNull(student.email());
        if (email == null) {
            return SendStudentReminderOutcome.badRequest("Student has no email");
        }
        List<StudentPaymentRow> payments = supabaseRest.fetchUnpaidPaymentsForStudent(studentId);
        List<DueItem> dueItems = new ArrayList<>();
        for (StudentPaymentRow p : payments) {
            String status = switch (coalesce(p.paymentStatus())) {
                case "paid_partially" -> "Partially paid";
                case "unpaid" -> "Unpaid";
                default -> "Pending";
            };
            dueItems.add(new DueItem(
                    status,
                    trimOrElse(p.subjects(), "—"),
                    p.balanceAmount() != null ? p.balanceAmount() : BigDecimal.ZERO,
                    p.currency()
            ));
        }
        if (dueItems.isEmpty()) {
            return SendStudentReminderOutcome.badRequest(
                    "Student has no unpaid or partially paid payments; no reminder sent.");
        }
        String name = trimOrElse(student.studentName(), email.split("@")[0]);
        if (emailService.sendReminderEmail(email, name, dueItems, ReminderEmailOptions.studentDefaults())) {
            return SendStudentReminderOutcome.ok();
        }
        return SendStudentReminderOutcome.serverError("Failed to send email");
    }

    private static String trimOrNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static String trimOrElse(String s, String fallback) {
        String t = trimOrNull(s);
        return t != null ? t : fallback;
    }

    private static String coalesce(String s) {
        return s != null ? s : "";
    }
}
