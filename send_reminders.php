<?php
// send_reminders.php — daily cron script, sends WhatsApp reminder for tomorrow's appointments
// Cron: 0 9 * * * curl -s "https://manageapp.in/api/send_reminders.php?secret=remind2026"
require_once __DIR__ . '/db_connect.php';
require_once __DIR__ . '/whatsapp_config.php';

if (($_GET['secret'] ?? '') !== 'remind2026') {
    http_response_code(403);
    die('Forbidden');
}

header('Content-Type: application/json; charset=utf-8');

function hebrew_day_reminder(string $date): string {
    $days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    return $days[(int) date('w', strtotime($date))];
}

function format_time_reminder(string $time): string {
    return substr($time, 0, 5);
}

function send_whatsapp_reminder(string $phone, string $message): void {
    $phoneForApi = (strpos($phone, '0') === 0) ? '972' . substr($phone, 1) : $phone;
    $postData = json_encode(['phone' => $phoneForApi, 'message' => $message]);
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, WHATSAPP_API_URL);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_POST, 1);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $postData);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_exec($ch);
    curl_close($ch);
}

try {
    $stmt = $conn->prepare("
        SELECT
            a.id,
            a.appointment_date,
            a.appointment_time,
            cu.phone        AS customer_phone,
            cu.first_name   AS customer_first,
            s.name          AS service_name,
            wu.first_name   AS worker_first,
            wu.last_name    AS worker_last,
            b.business_name
        FROM appointments a
        INNER JOIN users    cu ON cu.id = a.user_id AND COALESCE(cu.notifications_enabled, 1) = 1
        INNER JOIN services s  ON s.id  = a.service_id
        LEFT  JOIN users    wu ON wu.id = a.worker_id
        LEFT  JOIN businesses b ON b.tenant_id = cu.tenant_id
        WHERE a.appointment_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
          AND a.status = 'confirmed'
    ");
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $sent = 0;
    foreach ($rows as $row) {
        $customerPhone = (string) ($row['customer_phone'] ?? '');
        if ($customerPhone === '') continue;

        $customerName  = trim((string) ($row['customer_first'] ?? ''));
        $greeting      = $customerName !== '' ? "היי {$customerName}!" : 'היי!';
        $businessName  = !empty($row['business_name']) ? (string) $row['business_name'] : 'העסק';
        $serviceName   = (string) ($row['service_name'] ?? '');
        $workerFirst   = trim((string) ($row['worker_first'] ?? ''));
        $workerLast    = trim((string) ($row['worker_last'] ?? ''));
        $workerName    = trim("{$workerFirst} {$workerLast}");
        $day           = hebrew_day_reminder((string) $row['appointment_date']);
        $time          = format_time_reminder((string) $row['appointment_time']);

        $workerLine = $workerName !== '' ? "\n👤 עם: {$workerName}" : '';
        $message = "{$greeting} תזכורת לתור שלך מחר ב{$businessName} 💈\n"
                 . "📅 יום {$day} בשעה {$time}\n"
                 . "✂️ {$serviceName}"
                 . $workerLine . "\n"
                 . "מחכים לך!";

        send_whatsapp_reminder($customerPhone, $message);
        $sent++;
    }

    echo json_encode(['status' => 'success', 'sent' => $sent], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
