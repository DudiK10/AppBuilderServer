<?php
// backend/api/check_user_status.php — בדיקת סטטוס משתמש עם כניסה לאפליקציה
require_once __DIR__ . '/db_connect.php';

$token = resolve_api_token(null);

if ($token === null || trim($token) === '') {
    http_response_code(401);
    echo json_encode(['status' => 'error', 'code' => 'missing_token', 'message' => 'לא נמצא טוקן'], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    // Try auth_token column first, then token column
    $user = null;
    foreach (['auth_token', 'token', 'access_token'] as $col) {
        try {
            $stmt = $conn->prepare("SELECT id, role, COALESCE(is_blocked, 0) AS is_blocked FROM users WHERE $col = ? LIMIT 1");
            $stmt->execute([trim($token)]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row) { $user = $row; break; }
        } catch (PDOException $e) {
            continue;
        }
    }

    if (!$user) {
        http_response_code(401);
        echo json_encode(['status' => 'error', 'code' => 'invalid_token', 'message' => 'טוקן לא תקין'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ((int)($user['is_blocked'] ?? 0) === 1) {
        http_response_code(401);
        echo json_encode(['status' => 'error', 'code' => 'user_blocked', 'message' => 'המשתמש חסום'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    echo json_encode([
        'status'     => 'success',
        'id'         => (int) $user['id'],
        'role'       => (string) ($user['role'] ?? ''),
        'is_blocked' => false,
    ], JSON_UNESCAPED_UNICODE);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'שגיאת שרת'], JSON_UNESCAPED_UNICODE);
}
