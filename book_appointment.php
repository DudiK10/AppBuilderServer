<?php
// backend/api/book_appointment.php — קביעת תור עם אימות Bearer (כמו cancel_appointment)
require_once __DIR__ . '/db_connect.php';
require_once __DIR__ . '/business_closure_lib.php';
require_once __DIR__ . '/whatsapp_config.php';

function book_appointment_has_worker_column(PDO $conn): bool
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    try {
        $db = (string) $conn->query('SELECT DATABASE()')->fetchColumn();
        $st = $conn->prepare(
            'SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = \'appointments\' AND COLUMN_NAME = \'worker_id\''
        );
        $st->execute([$db]);
        $cache = ((int) $st->fetchColumn()) > 0;
    } catch (PDOException $e) {
        $cache = false;
    }

    return $cache;
}

/**
 * @param int $httpCode
 * @param string $code קוד פנימי (למשל auth_account_blocked)
 * @param string $message הודעה קריאה (אנגלית/עברית)
 * @param string|null $errorCode קוד יציב ללקוח (למשל USER_BLOCKED)
 * @param string|null $blockSource מקור החסימה לדיבאג (למשל users_table_auth_row)
 */
function book_appointment_fail(int $httpCode, string $code, string $message, ?string $errorCode = null, ?string $blockSource = null): void
{
    http_response_code($httpCode);
    header('Content-Type: application/json; charset=utf-8');
    $payload = [
        'success' => false,
        'status' => 'error',
        'code' => $code,
        'message' => $message,
    ];
    if ($errorCode !== null && $errorCode !== '') {
        $payload['error_code'] = $errorCode;
    }
    if ($blockSource !== null && $blockSource !== '') {
        $payload['block_source'] = $blockSource;
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function hebrew_day_booking(string $date): string {
    $days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    return $days[(int) date('w', strtotime($date))];
}

function format_time_booking(string $time): string {
    return substr($time, 0, 5);
}

function send_whatsapp_booking(string $phone, string $message): void {
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

$data = json_decode(file_get_contents('php://input'));

if (!is_object($data)) {
    book_appointment_fail(400, 'invalid_body', 'גוף הבקשה לא תקין');
}

if (!isset($data->phone) || !isset($data->serviceId) || !isset($data->date) || !isset($data->time)) {
    book_appointment_fail(400, 'missing_fields', 'חסרים נתונים לקביעת התור');
}

$token = resolve_api_token($data);
if (!is_string($token) || trim($token) === '') {
    book_appointment_fail(
        401,
        'missing_token',
        '401 Unauthorized: חסר טוקן — שלח Authorization: Bearer <token> או שדה token בגוף ה-JSON'
    );
}
$token = trim($token);

$phone = trim((string) $data->phone);
$serviceId = (int) $data->serviceId;
$date = trim((string) $data->date);
$time = trim((string) $data->time);

$workerIdOpt = null;
if (isset($data->worker_id)) {
    $w = (int) $data->worker_id;
    if ($w > 0) {
        $workerIdOpt = $w;
    }
}

if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
    book_appointment_fail(400, 'invalid_date', 'תאריך לא תקין');
}

try {
    $authStmt = $conn->prepare(
        'SELECT id, phone, COALESCE(is_blocked, 0) AS is_blocked, COALESCE(role, \'customer\') AS role, tenant_id FROM users WHERE auth_token = ? LIMIT 1'
    );
    $authStmt->execute([$token]);
    $authUser = $authStmt->fetch(PDO::FETCH_ASSOC);

    if (!$authUser) {
        book_appointment_fail(
            401,
            'invalid_token',
            '401 Unauthorized: טוקן לא תקין או פג תוקף'
        );
    }

    $authUserId = (int) $authUser['id'];
    $authRole = strtolower(trim((string) ($authUser['role'] ?? 'customer')));
    if ($authRole === '') {
        $authRole = 'customer';
    }
    $tenantId = (string) ($authUser['tenant_id'] ?? '');

    if ((int) ($authUser['is_blocked'] ?? 0) === 1) {
        book_appointment_fail(
            403,
            'auth_account_blocked',
            'Blocked by users.is_blocked on the row matched by auth token (fresh DB lookup).',
            'USER_BLOCKED',
            'users_table_auth_row'
        );
    }

    if (business_closure_reason_for_date($conn, $date) !== null) {
        echo json_encode([
            'success' => false,
            'status' => 'error',
            'code' => 'business_closed',
            'message' => 'ביום זה העסק סגור. נא לבחור תאריך אחר.',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $userStmt = $conn->prepare(
        'SELECT id, first_name, COALESCE(is_blocked, 0) AS is_blocked FROM users WHERE phone = :phone LIMIT 1'
    );
    $userStmt->execute([':phone' => $phone]);

    if ($userStmt->rowCount() === 0) {
        echo json_encode([
            'success' => false,
            'status' => 'error',
            'code' => 'user_not_found',
            'message' => 'משתמש לא נמצא',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $user = $userStmt->fetch(PDO::FETCH_ASSOC);
    $userId = (int) $user['id'];
    $customerFirstName = trim((string) ($user['first_name'] ?? ''));

    if ($authUserId !== $userId && $authRole !== 'admin') {
        book_appointment_fail(
            403,
            'forbidden_phone_mismatch',
            '403 Forbidden: ניתן לקבוע תור רק למספר הטלפון של המשתמש המחובר. אדמין יכול לקבוע עבור כל לקוח.'
        );
    }

    if ((int) ($user['is_blocked'] ?? 0) === 1) {
        book_appointment_fail(
            403,
            'target_account_blocked',
            'Blocked by users.is_blocked on the row matched by booking phone (LIMIT 1; duplicate phone rows possible).',
            'USER_BLOCKED',
            'users_table_phone_row'
        );
    }

    $countStmt = $conn->prepare("
        SELECT COUNT(*) as cnt FROM appointments
        WHERE user_id = :user_id AND status NOT IN ('cancelled', 'cancelled_by_business')
          AND (appointment_date > CURDATE() OR (appointment_date = CURDATE() AND appointment_time > CURTIME()))
    ");
    $countStmt->execute([':user_id' => $userId]);
    $count = (int) $countStmt->fetch(PDO::FETCH_ASSOC)['cnt'];
    if ($count >= 2) {
        echo json_encode([
            'success' => false,
            'status' => 'error',
            'code' => 'too_many_active',
            'message' => 'יש לך כבר 2 תורים פעילים. ניתן לקבוע תור חדש רק לאחר ביטול או סיום אחד מהם',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $svcStmt = $conn->prepare('SELECT id, name, COALESCE(worker_id, 0) AS wid FROM services WHERE id = ? AND is_active = 1 LIMIT 1');
    $svcStmt->execute([$serviceId]);
    $svcRow = $svcStmt->fetch(PDO::FETCH_ASSOC);
    if (!$svcRow) {
        echo json_encode([
            'success' => false,
            'status' => 'error',
            'code' => 'service_not_found',
            'message' => 'השירות לא נמצא או לא פעיל',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $svcWorkerId = (int) ($svcRow['wid'] ?? 0);
    $serviceName = (string) ($svcRow['name'] ?? '');

    if ($workerIdOpt !== null && $svcWorkerId > 0 && $svcWorkerId !== $workerIdOpt) {
        echo json_encode([
            'success' => false,
            'status' => 'error',
            'code' => 'worker_mismatch',
            'message' => 'השירות לא תואם לספר שנבחר',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $hasWorkerCol = book_appointment_has_worker_column($conn);
    $insertWorkerId = null;
    if ($hasWorkerCol) {
        if ($svcWorkerId > 0) {
            $insertWorkerId = $svcWorkerId;
        } elseif ($workerIdOpt !== null) {
            $insertWorkerId = $workerIdOpt;
        }
    }

    if ($hasWorkerCol && $insertWorkerId !== null) {
        $insertStmt = $conn->prepare(
            "INSERT INTO appointments (user_id, service_id, appointment_date, appointment_time, status, worker_id)
             VALUES (:user_id, :service_id, :appointment_date, :appointment_time, 'confirmed', :worker_id)"
        );
        $insertStmt->execute([
            ':user_id' => $userId,
            ':service_id' => $serviceId,
            ':appointment_date' => $date,
            ':appointment_time' => $time,
            ':worker_id' => $insertWorkerId,
        ]);
    } else {
        $insertStmt = $conn->prepare(
            "INSERT INTO appointments (user_id, service_id, appointment_date, appointment_time, status)
             VALUES (:user_id, :service_id, :appointment_date, :appointment_time, 'confirmed')"
        );
        $insertStmt->execute([
            ':user_id' => $userId,
            ':service_id' => $serviceId,
            ':appointment_date' => $date,
            ':appointment_time' => $time,
        ]);
    }

    // WhatsApp booking confirmation
    try {
        $workerName = '';
        $finalWorkerId = $insertWorkerId ?? $workerIdOpt;
        if ($finalWorkerId !== null && $finalWorkerId > 0) {
            $wStmt = $conn->prepare('SELECT first_name, last_name FROM users WHERE id = ? LIMIT 1');
            $wStmt->execute([$finalWorkerId]);
            $wRow = $wStmt->fetch(PDO::FETCH_ASSOC);
            if ($wRow) {
                $workerName = trim(trim((string)($wRow['first_name'] ?? '')) . ' ' . trim((string)($wRow['last_name'] ?? '')));
            }
        }

        $businessName = 'העסק';
        if ($tenantId !== '') {
            $bStmt = $conn->prepare('SELECT business_name FROM businesses WHERE tenant_id = ? LIMIT 1');
            $bStmt->execute([$tenantId]);
            $bRow = $bStmt->fetch(PDO::FETCH_ASSOC);
            if ($bRow && !empty(trim((string)$bRow['business_name']))) {
                $businessName = trim((string)$bRow['business_name']);
            }
        }

        $greeting  = $customerFirstName !== '' ? "שלום {$customerFirstName}!" : 'שלום!';
        $day       = hebrew_day_booking($date);
        $timeShort = format_time_booking($time);
        $workerLine = $workerName !== '' ? "\n👤 עם: {$workerName}" : '';

        $message = "{$greeting} התור שלך ב{$businessName} אושר ✅\n"
                 . "📅 יום {$day}, {$date} בשעה {$timeShort}\n"
                 . "✂️ שירות: {$serviceName}"
                 . $workerLine . "\n"
                 . "נשמח לראותך!";

        send_whatsapp_booking($phone, $message);
    } catch (Exception $e) {
        // WhatsApp failure should not block booking success
    }

    echo json_encode([
        'success' => true,
        'status' => 'success',
        'message' => 'התור נקבע בהצלחה!',
    ], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'status' => 'error',
        'code' => 'server_error',
        'message' => 'שגיאת שרת: ' . $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
}
