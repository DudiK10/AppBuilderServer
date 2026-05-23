<?php
// backend/api/send_otp.php
require_once 'db_connect.php';
require_once 'whatsapp_config.php';

$data = json_decode(file_get_contents("php://input"));

if (!isset($data->phone) || empty(trim($data->phone))) {
    echo json_encode(["status" => "error", "message" => "נא להזין מספר טלפון"]);
    exit;
}

$phone = trim($data->phone);
$tenantId = isset($data->tenant_id) ? trim((string)$data->tenant_id) : '';

if ($tenantId === '') {
    echo json_encode(["status" => "error", "message" => "חסר מזהה עסק"]);
    exit;
}

// 1. יצירת קוד אימות רנדומלי בן 4 ספרות
$otpCode = (string) rand(1000, 9999);

try {
    // 2. שמירת הקוד במסד הנתונים — חיפוש לפי טלפון + tenant_id
    $stmt = $conn->prepare("SELECT id, COALESCE(is_blocked, 0) AS is_blocked FROM users WHERE phone = :phone AND tenant_id = :tid");
    $stmt->execute([':phone' => $phone, ':tid' => $tenantId]);

    if ($stmt->rowCount() > 0) {
        $existingUser = $stmt->fetch(PDO::FETCH_ASSOC);

        // Block check — do not send OTP to blocked users
        if ((int)($existingUser['is_blocked'] ?? 0) === 1) {
            echo json_encode(["status" => "error", "message" => "החשבון שלך חסום. אנא פנה למנהל."]);
            exit;
        }

        $updateStmt = $conn->prepare("UPDATE users SET otp_code = :otp WHERE phone = :phone AND tenant_id = :tid");
        $updateStmt->execute([':otp' => $otpCode, ':phone' => $phone, ':tid' => $tenantId]);
    } else {
        // משתמש חדש לעסק זה — תמיד נוצר כלקוח
        $insertStmt = $conn->prepare("INSERT INTO users (phone, role, otp_code, tenant_id) VALUES (:phone, 'customer', :otp, :tid)");
        $insertStmt->execute([':phone' => $phone, ':otp' => $otpCode, ':tid' => $tenantId]);
    }

    // 3. שליחת הקוד בוואטסאפ
    $whatsappApiUrl = WHATSAPP_API_URL;
    $bizStmt = $conn->prepare("SELECT business_name FROM businesses WHERE tenant_id = ? LIMIT 1");
    $bizStmt->execute([$tenantId]);
    $bizRow = $bizStmt->fetch(PDO::FETCH_ASSOC);
    $businessName = ($bizRow && !empty(trim((string)$bizRow['business_name']))) ? trim((string)$bizRow['business_name']) : 'האפליקציה';
    $messageText = "שלום! קוד האימות שלך לאפליקציית {$businessName} הוא: *" . $otpCode . "*";
    $phoneForApi = (strpos($phone, '0') === 0) ? '972' . substr($phone, 1) : $phone;
    $postData = json_encode(["phone" => $phoneForApi, "message" => $messageText]);

    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $whatsappApiUrl);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_POST, 1);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $postData);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_exec($ch);
    curl_close($ch);

    // 4. החזרת תשובה חיובית
    echo json_encode([
        "status" => "success",
        "message" => "קוד אימות נשלח בהצלחה"
    ]);

} catch(PDOException $e) {
    echo json_encode(["status" => "error", "message" => "שגיאת שרת: " . $e->getMessage()]);
}
?>
