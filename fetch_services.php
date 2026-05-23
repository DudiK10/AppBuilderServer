<?php
// backend/api/fetch_services.php — שירותים לפי הרשאה: עובד=שלו בלבד, אדמין=גלובלי, לקוח=לפי worker_id
require_once __DIR__ . '/db_connect.php';

function fetch_services_column_worker_exists(PDO $pdo): bool {
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

function fetch_services_resolve_user(PDO $conn, ?string $token): ?array {
    if (!is_string($token) || trim($token) === '') return null;
    try {
        $st = $conn->prepare('SELECT id, role FROM users WHERE auth_token = ? LIMIT 1');
        $st->execute([trim($token)]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row) return null;
        return ['id' => (int)$row['id'], 'role' => (string)($row['role'] ?? '')];
    } catch (PDOException $e) { return null; }
}

$jsonForToken = null;
$token = resolve_api_token($jsonForToken);
if ($token === null && isset($_GET['token']) && is_string($_GET['token'])) {
    $t = trim($_GET['token']);
    $token = $t !== '' ? $t : null;
}

$user       = fetch_services_resolve_user($conn, $token);
$role       = $user['role'] ?? null;
$authUserId = $user['id'] ?? null;

$workerIdParam = null;
if (isset($_GET['worker_id'])) {
    $w = (int) $_GET['worker_id'];
    $workerIdParam = $w > 0 ? $w : null;
}

$tenantIdParam = null;
if (isset($_GET['tenant_id'])) {
    $t = trim((string) $_GET['tenant_id']);
    $tenantIdParam = $t !== '' ? $t : null;
}

$hasWorkerCol = fetch_services_column_worker_exists($conn);

try {
    $sql    = 'SELECT * FROM services WHERE is_active = 1';
    $params = [];

    if ($tenantIdParam !== null) {
        $sql .= ' AND tenant_id = :tid';
        $params[':tid'] = $tenantIdParam;
    }

    if ($hasWorkerCol) {
        if ($role === 'worker' && $authUserId !== null) {
            // Worker sees ONLY their own services — strict separation
            $sql .= ' AND worker_id = :my_worker_id';
            $params[':my_worker_id'] = $authUserId;

        } elseif ($role === 'admin') {
            if ($workerIdParam !== null) {
                // Admin viewing a specific worker's services (future admin panel)
                $sql .= ' AND worker_id = :filter_worker_id';
                $params[':filter_worker_id'] = $workerIdParam;
            } else {
                // Admin sees only global (business-level) services
                $sql .= ' AND worker_id IS NULL';
            }

        } else {
            // Customer / guest booking — filter by selected worker
            if ($workerIdParam !== null) {
                $sql .= ' AND worker_id = :filter_worker_id';
                $params[':filter_worker_id'] = $workerIdParam;
            } else {
                // No worker selected — show global services only
                $sql .= ' AND worker_id IS NULL';
            }
        }
    }

    $sql .= ' ORDER BY id ASC';

    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    $services = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        'status'   => 'success',
        'services' => $services,
    ], JSON_UNESCAPED_UNICODE);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'status'  => 'error',
        'message' => 'שגיאת שרת: ' . $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
}
