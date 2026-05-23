<?php
// backend/api/update_service.php — עדכון שירות (אדמין כל שירות; עובד — שלו בלבד)
require_once __DIR__ . '/db_connect.php';

$data  = json_decode(file_get_contents('php://input'));
$token = resolve_api_token(is_object($data) ? $data : null);

// Resolve calling user
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

$serviceId = 0;
if (isset($data->id))         $serviceId = (int) $data->id;
elseif (isset($data->service_id)) $serviceId = (int) $data->service_id;

if ($serviceId <= 0) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'חסר מזהה שירות'], JSON_UNESCAPED_UNICODE);
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

// Workers can only update their own services
if ($user['role'] === 'worker') {
    try {
        $chk = $conn->prepare('SELECT worker_id FROM services WHERE id = ? AND is_active = 1 LIMIT 1');
        $chk->execute([$serviceId]);
        $svc = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$svc || (int)($svc['worker_id'] ?? 0) !== $user['id']) {
            http_response_code(403);
            echo json_encode(['status' => 'error', 'message' => 'אין הרשאה לערוך שירות זה'], JSON_UNESCAPED_UNICODE);
            exit;
        }
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['status' => 'error', 'message' => 'שגיאת שרת'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

try {
    $stmt = $conn->prepare(
        'UPDATE services SET name = :name, duration_minutes = :duration, price = :price WHERE id = :id'
    );
    $stmt->execute([':name' => $name, ':duration' => $duration, ':price' => $price, ':id' => $serviceId]);

    if ($stmt->rowCount() > 0) {
        echo json_encode(['status' => 'success', 'message' => 'השירות עודכן בהצלחה'], JSON_UNESCAPED_UNICODE);
    } else {
        http_response_code(404);
        echo json_encode(['status' => 'error', 'message' => 'לא נמצא שירות לעדכון'], JSON_UNESCAPED_UNICODE);
    }
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'שגיאת שרת: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
