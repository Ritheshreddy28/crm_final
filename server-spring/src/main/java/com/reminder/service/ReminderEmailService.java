package com.reminder.service;

import com.reminder.dto.DueItem;
import com.reminder.dto.ReminderEmailOptions;
import jakarta.mail.internet.MimeMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.util.List;
import java.util.Locale;

@Service
public class ReminderEmailService {

    private static final Logger log = LoggerFactory.getLogger(ReminderEmailService.class);

    private final JavaMailSender mailSender;

    @Value("${spring.mail.username:}")
    private String fromAddress;

    @Value("${spring.mail.password:}")
    private String fromPassword;

    public ReminderEmailService(JavaMailSender mailSender) {
        this.mailSender = mailSender;
    }

    public boolean sendReminderEmail(String to, String name, List<DueItem> dueItems, ReminderEmailOptions options) {
        if (to == null || to.isBlank()) {
            log.warn("[reminder] sendMail skipped: recipient email missing");
            return false;
        }
        if (fromAddress == null || fromAddress.isBlank()) {
            log.warn("[reminder] sendMail skipped: SMTP username missing (set GMAIL_USER / spring.mail.username)");
            return false;
        }
        if (fromPassword == null || fromPassword.isBlank()) {
            log.warn("[reminder] sendMail skipped: SMTP password missing (set GMAIL_APP_PASS / spring.mail.password)");
            return false;
        }

        ReminderEmailOptions o = options != null ? options : ReminderEmailOptions.studentDefaults();
        String subject = firstNonBlank(o.subject(), "⏰ Payment Reminder");
        String title = firstNonBlank(o.title(), "Payment Reminder");
        String intro = firstNonBlank(o.intro(), "You have the following pending balance(s):");
        String footer = firstNonBlank(o.footer(),
                "This is an automated reminder. Please clear your pending balance at your earliest.");
        String secondCol = firstNonBlank(o.secondColumnHeader(), "Subjects / Course");

        StringBuilder rows = new StringBuilder();
        for (DueItem d : dueItems) {
            rows.append("<tr><td style=\"padding:8px 12px;border-bottom:1px solid #eee\">")
                    .append(escapeHtml(d.dueDate()))
                    .append("</td><td style=\"padding:8px 12px;border-bottom:1px solid #eee\">")
                    .append(escapeHtml(d.senderName()))
                    .append("</td><td style=\"padding:8px 12px;border-bottom:1px solid #eee\">")
                    .append(formatAmount(d.amount(), d.currency()))
                    .append("</td></tr>");
        }

        String html = """
                <!DOCTYPE html>
                <html>
                <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
                <body style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#333;background:#f9fafb">
                  <div style="background:#fff;border-radius:8px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
                    <h1 style="margin:0 0 16px;font-size:20px;color:#111">%s</h1>
                    <p style="margin:0 0 20px;color:#555;line-height:1.5">Hi %s,</p>
                    <p style="margin:0 0 16px;color:#555;line-height:1.5">%s</p>
                    <table style="width:100%;border-collapse:collapse;font-size:14px">
                      <thead><tr style="background:#f3f4f6"><th style="padding:8px 12px;text-align:left">Status</th><th style="padding:8px 12px;text-align:left">%s</th><th style="padding:8px 12px;text-align:left">Amount to be paid</th></tr></thead>
                      <tbody>%s</tbody>
                    </table>
                    <p style="margin:20px 0 0;font-size:13px;color:#888">%s</p>
                  </div>
                </body>
                </html>
                """.formatted(
                escapeHtml(title),
                escapeHtml(name),
                escapeHtml(intro),
                escapeHtml(secondCol),
                rows.toString(),
                escapeHtml(footer));

        try {
            MimeMessage message = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
            helper.setFrom(fromAddress.trim());
            helper.setTo(to.trim());
            helper.setSubject(subject);
            helper.setText(html, true);
            mailSender.send(message);
            return true;
        } catch (Exception e) {
            log.warn("[reminder] sendMail failed: {}", e.getMessage());
            return false;
        }
    }

    private static String firstNonBlank(String a, String b) {
        if (a != null && !a.isBlank()) {
            return a;
        }
        return b;
    }

    private static String escapeHtml(String s) {
        if (s == null) {
            return "—";
        }
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    private static String formatAmount(BigDecimal amount, String currency) {
        if (amount == null) {
            return "—";
        }
        String sym = "INR".equalsIgnoreCase(currency) ? "₹"
                : "USD".equalsIgnoreCase(currency) ? "$"
                : currency != null ? currency : "";
        DecimalFormat fmt = new DecimalFormat("#,##0.##", DecimalFormatSymbols.getInstance(Locale.forLanguageTag("en-IN")));
        return sym + fmt.format(amount);
    }
}
