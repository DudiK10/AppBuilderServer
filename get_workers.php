<?php
// backend/api/get_workers.php — רשימת עובדים (אדמין בלבד) + חיפוש
require_once __DIR__ . '/db_connect.php';

$token = resolve_api_token(null);
verify_admin($conn, $token);

$q = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
$like = '%' . $q . '%';

try {
    $sql = "
        SELECT
            u.id,
            u.phone,
            u.first_name,
            u.last_name,
            COALESCE(u.is_blocked, 0) AS is_blocked,
            u.block_reason
        FROM users u
        WHERE LOWER(TRIM(COALESCE(u.role, ''))) = 'worker'
    ";
    $params = [];
    if ($q !== '') {
        $sql .= " AND (
            u.phone LIKE :like
            OR CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,'')) LIKE :like2
        )";
        $params[':like']  = $like;
        $params[':like2'] = $like;
    }
    $sql .= ' ORDER BY u.id DESC LIMIT 200';

    $stmt = $conn->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $workers = [];
    foreach ($rows as $row) {
        $fn   = trim((string) ($row['first_name'] ?? ''));
        $ln   = trim((string) ($row['last_name']  ?? ''));
        $full = trim($fn . ' ' . $ln);
        if ($full === '') $full = 'ללא שם';

        $workers[] = [
            'id'           => (int) $row['id'],
            'phone'        => (string) ($row['phone'] ?? ''),
            'full_name'    => $full,
            'first_name'   => $fn,
            'last_name'    => $ln,
            'is_blocked'   => (int) $row['is_blocked'] === 1,
            'block_reason' => $row['block_reason'] !== null ? (string) $row['block_reason'] : null,
        ];
    }

    echo json_encode([
        'status'  => 'success',
        'success' => true,
        'workers' => $workers,
    ], JSON_UNESCAPED_UNICODE);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'DB Error: ' . $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE);
}
