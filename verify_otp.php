<?php
// backend/api/verify_otp.php — מחזיר user + role מפורש לניתוב באפליקציה
require_once __DIR__ . '/db_connect.php';

$data = json_decode(file_get_contents("php://input"));

if (!isset($data->phone) || !isset($data->otpCode)) {
    echo json_encode(["status" => "error", "message" => "חסרים נתונים לאימות"]);
    exit;
}

$phone = trim($data->phone);
$otpCode = trim($data->otpCode);
$tenantId = isset($data->tenant_id) ? trim((string)$data->tenant_id) : '';

if ($tenantId === '') {
    echo json_encode(["status" => "error", "message" => "חסר מזהה עסק"]);
    exit;
}

try {
    $token = bin2hex(random_bytes(32));

    $upd = $conn->prepare(
        "UPDATE users SET auth_token = :token, otp_code = NULL WHERE phone = :phone AND otp_code = :otp AND tenant_id = :tid"
    );
    $upd->execute([
        ':token' => $token,
        ':phone' => $phone,
        ':otp'   => $otpCode,
        ':tid'   => $tenantId,
    ]);

    if ($upd->rowCount() === 0) {
        echo json_encode(["status" => "error", "message" => "קוד האימות שגוי או פג תוקף"]);
        exit;
    }

    $stmt = $conn->prepare("SELECT * FROM users WHERE phone = :phone AND tenant_id = :tid LIMIT 1");
    $stmt->execute([':phone' => $phone, ':tid' => $tenantId]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        echo json_encode(["status" => "error", "message" => "שגיאת שרת"]);
        exit;
    }

    // Block check — blocked users cannot log in
    if ((int)($user['is_blocked'] ?? 0) === 1) {
        echo json_encode(["status" => "error", "message" => "החשבון שלך חסום. אנא פנה למנהל."]);
        exit;
    }

    unset($user['otp_code'], $user['auth_token']);
    $user['token'] = $token;

    $rawRole = isset($user['role']) ? trim((string) $user['role']) : '';
    $role = $rawRole !== '' ? $rawRole : 'customer';
    $user['role'] = $role;

    $needsProfileCompletion = empty($user['first_name']);

    echo json_encode([
        'status' => 'success',
        'message' => 'אומת בהצלחה',
        'needs_profile_completion' => $needsProfileCompletion,
        'role' => $role,
        'user' => $user,
    ], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    echo json_encode(["status" => "error", "message" => "שגיאת שרת: " . $e->getMessage()]);
}
