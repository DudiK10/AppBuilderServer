<?php
// backend/api/add_service.php — הוספת שירות (אדמין בלבד או עובד לשירות שלו)
require_once __DIR__ . '/db_connect.php';

$data = json_decode(file_get_contents('php://input'));
$token = resolve_api_token(is_object($data) ? $data : null);

// Resolve the calling user (admin or worker)
$user = null;
if (is_string($token) && trim($token) !== '') {
    try {
        $st = $conn->prepare('SELECT id, role FROM users WHERE auth_token = ? LIMIT 1');
        $st->execute([trim($token)]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if ($row) $user = ['id' => (int)$row['id'], 'role' => (string)($row['role'] ?? '')];
    } catch (PDOException $e) {}
}

if (!$user || !in_array($user['role'], ['admin', 'worker'], true)) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'אין הרשאה'], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!is_object($data) || !isset($data->name) || !isset($data->duration) || !isset($data->price)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'חסרים נתונים'], JSON_UNESCAPED_UNICODE);
    exit;
}

$name     = trim((string) $data->name);
$duration = (int) $data->duration;
$price    = (float) $data->price;

if ($name === '' || $duration <= 0 || $price < 0) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'שם, משך או מחיר לא תקינים'], JSON_UNESCAPED_UNICODE);
    exit;
}

// Workers always attach their own ID; admins can pass an explicit worker_id or null (global)
if ($user['role'] === 'worker') {
    $workerId = $user['id'];
} else {
    $workerId = null;
    if (isset($data->worker_id) && $data->worker_id !== '' && $data->worker_id !== null) {
        $w = (int) $data->worker_id;
        $workerId = $w > 0 ? $w : null;
    }
}

$tenantId = isset($data->tenant_id) && is_string($data->tenant_id) && trim($data->tenant_id) !== ''
    ? trim($data->tenant_id)
    : null;

function add_service_worker_column_exists(PDO $pdo): bool {
    try {
        $db = (string) $pdo->query('SELECT DATABASE()')->fetchColumn();
        $st = $pdo->prepare(
            'SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = \'services\' AND COLUMN_NAME = \'worker_id\''
        );
        $st->execute([$db]);
        return (int) $st->fetchColumn() > 0;
    } catch (PDOException $e) { return false; }
}

try {
    if (add_service_worker_column_exists($conn)) {
        $stmt = $conn->prepare(
            'INSERT INTO services (name, duration_minutes, price, icon, is_active, worker_id, tenant_id)
             VALUES (:name, :duration, :price, \'briefcase-outline\', 1, :worker_id, :tid)'
        );
        $stmt->execute([
            ':name'      => $name,
            ':duration'  => $duration,
            ':price'     => $price,
            ':worker_id' => $workerId,
            ':tid'       => $tenantId,
        ]);
    } else {
        $stmt = $conn->prepare(
            'INSERT INTO services (name, duration_minutes, price, icon, is_active, tenant_id)
             VALUES (:name, :duration, :price, \'briefcase-outline\', 1, :tid)'
        );
        $stmt->execute([':name' => $name, ':duration' => $duration, ':price' => $price, ':tid' => $tenantId]);
    }

    echo json_encode([
        'status'  => 'success',
        'message' => 'השירות נוסף בהצלחה',
        'id'      => (int) $conn->lastInsertId(),
    ], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'שגיאת שרת: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
