<?php
// backend/api/update_notifications.php — save customer reminder preference
require_once 'db_connect.php';

$data = json_decode(file_get_contents('php://input'));
$token = resolve_api_token(is_object($data) ? $data : null);

if (!is_string($token) || trim($token) === '') {
    echo json_encode(['status' => 'error', 'message' => 'חסר טוקן'], JSON_UNESCAPED_UNICODE);
    exit;
}

$enabled = isset($data->enabled) ? (int)(bool)$data->enabled : 1;

try {
    $stmt = $conn->prepare("UPDATE users SET notifications_enabled = ? WHERE auth_token = ?");
    $stmt->execute([$enabled, trim($token)]);
    echo json_encode(['status' => 'success'], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    echo json_encode(['status' => 'error', 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
