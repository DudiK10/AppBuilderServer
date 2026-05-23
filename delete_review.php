<?php
// backend/api/delete_review.php — מחיקת ביקורת (אדמין בלבד)
require_once __DIR__ . '/db_connect.php';

$data  = json_decode(file_get_contents('php://input'));
$token = resolve_api_token(is_object($data) ? $data : null);

// Only admins can delete reviews
$user = null;
if (is_string($token) && trim($token) !== '') {
    try {
        $st = $conn->prepare('SELECT id, role FROM users WHERE auth_token = ? LIMIT 1');
        $st->execute([trim($token)]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if ($row) $user = ['id' => (int)$row['id'], 'role' => (string)($row['role'] ?? '')];
    } catch (PDOException $e) {}
}

if (!$user || $user['role'] !== 'admin') {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'אין הרשאה — אדמין בלבד'], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!is_object($data) || !isset($data->review_id)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'חסר מזהה ביקורת'], JSON_UNESCAPED_UNICODE);
    exit;
}

$reviewId = (int) $data->review_id;
if ($reviewId <= 0) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'מזהה ביקורת לא תקין'], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $stmt = $conn->prepare('DELETE FROM reviews WHERE id = ?');
    $stmt->execute([$reviewId]);

    if ($stmt->rowCount() > 0) {
        echo json_encode(['status' => 'success', 'message' => 'הביקורת נמחקה'], JSON_UNESCAPED_UNICODE);
    } else {
        http_response_code(404);
        echo json_encode(['status' => 'error', 'message' => 'ביקורת לא נמצאה'], JSON_UNESCAPED_UNICODE);
    }
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'שגיאת שרת: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
