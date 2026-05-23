<?php
// backend/api/get_admin_appointments.php — יומן לאדמין (כל התורים) או לעובד (תורים משויכים אליו בלבד)
require_once __DIR__ . '/db_connect.php';
require_once __DIR__ . '/resolve_staff_user.php';

$data = json_decode(file_get_contents('php://input'));
$token = resolve_api_token(is_object($data) ? $data : null);
if ($token === null && isset($_GET['token']) && is_string($_GET['token']) && trim($_GET['token']) !== '') {
    $token = trim($_GET['token']);
}

$user = resolve_admin_or_worker_user($conn, $token);
if ($user === null) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'error' => 'Forbidden', 'message' => 'אין הרשאה — נדרש חשבון מנהל או עובד'], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!is_object($data) || !isset($data->date) || trim((string) $data->date) === '') {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'חסר תאריך (date בפורמט YYYY-MM-DD)'], JSON_UNESCAPED_UNICODE);
    exit;
}

$date = trim((string) $data->date);
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'פורמט תאריך לא תקין'], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $sql = "
        SELECT
            a.id,
            a.appointment_date,
            a.appointment_time,
            a.status,
            a.worker_id,
            u.first_name,
            u.last_name,
            u.phone,
            s.name AS service_name,
            NULLIF(TRIM(CONCAT(COALESCE(w.first_name, ''), ' ', COALESCE(w.last_name, ''))), '') AS worker_name
        FROM appointments a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN services s ON a.service_id = s.id
        LEFT JOIN users w ON a.worker_id = w.id
        WHERE a.appointment_date = :appt_date
          AND a.status = 'confirmed'
    ";

    $params = [':appt_date' => $date];

    if ($user['role'] === 'worker') {
        // Worker sees only their own appointments
        $sql .= ' AND a.worker_id = :staff_user_id';
        $params[':staff_user_id'] = $user['id'];
    } elseif ($user['role'] === 'admin' && is_object($data) && isset($data->worker_id)) {
        // Admin viewing a specific worker's calendar
        $filterWorkerId = (int) $data->worker_id;
        if ($filterWorkerId > 0) {
            $sql .= ' AND a.worker_id = :filter_worker_id';
            $params[':filter_worker_id'] = $filterWorkerId;
        }
    }
    // else: admin with no worker_id filter — sees all appointments

    $sql .= ' ORDER BY a.appointment_time ASC';

    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    $appointments = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $timeBlocks = [];
    try {
        $blockSql = "
            SELECT
                b.id,
                b.worker_id,
                b.block_date,
                TIME_FORMAT(b.start_time, '%H:%i') AS start_time,
                TIME_FORMAT(b.end_time, '%H:%i') AS end_time,
                b.reason,
                b.created_at
            FROM worker_time_blocks b
            WHERE b.block_date = :block_date
              AND b.worker_id = :block_staff_id
        ";
        $blockParams = [
            ':block_date'     => $date,
            ':block_staff_id' => $user['id'],
        ];
        $blockSql .= ' ORDER BY b.start_time ASC';
        $blockStmt = $conn->prepare($blockSql);
        $blockStmt->execute($blockParams);
        $timeBlocks = $blockStmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (PDOException $e) {
        // table may not exist yet
    }

    echo json_encode([
        'status'       => 'success',
        'appointments' => $appointments,
        'time_blocks'  => $timeBlocks,
    ], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'שגיאת שרת: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
