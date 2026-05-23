<?php
// backend/api/get_analytics.php — admin-only analytics dashboard
require_once __DIR__ . '/db_connect.php';

header('Content-Type: application/json; charset=utf-8');

$data = json_decode(file_get_contents('php://input'));
$token = resolve_api_token(is_object($data) ? $data : null);

if (!is_string($token) || trim($token) === '') {
    http_response_code(401);
    echo json_encode(['status' => 'error', 'message' => 'חסר טוקן'], JSON_UNESCAPED_UNICODE);
    exit;
}
$token = trim($token);

try {
    $authStmt = $conn->prepare(
        "SELECT id, role, tenant_id FROM users WHERE auth_token = ? LIMIT 1"
    );
    $authStmt->execute([$token]);
    $authUser = $authStmt->fetch(PDO::FETCH_ASSOC);

    if (!$authUser) {
        http_response_code(401);
        echo json_encode(['status' => 'error', 'message' => 'טוקן לא תקין'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $role = strtolower(trim((string)($authUser['role'] ?? '')));
    if ($role !== 'admin') {
        http_response_code(403);
        echo json_encode(['status' => 'error', 'message' => 'גישה למנהלים בלבד'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $tenantId = (string)($authUser['tenant_id'] ?? '');

    $hebrewMonths = ['', 'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
    $monthLabel = $hebrewMonths[(int)date('n')] . ' ' . date('Y');
    $hebrewDays = [1 => 'ראשון', 2 => 'שני', 3 => 'שלישי', 4 => 'רביעי', 5 => 'חמישי', 6 => 'שישי', 7 => 'שבת'];

    // This month: total bookings
    $st = $conn->prepare("
        SELECT COUNT(*) FROM appointments a
        INNER JOIN users u ON u.id = a.user_id AND u.tenant_id = ?
        WHERE YEAR(a.appointment_date) = YEAR(CURDATE())
          AND MONTH(a.appointment_date) = MONTH(CURDATE())
          AND a.status NOT IN ('cancelled','cancelled_by_business')
    ");
    $st->execute([$tenantId]);
    $totalBookings = (int)$st->fetchColumn();

    // This month: revenue
    $st = $conn->prepare("
        SELECT COALESCE(SUM(s.price), 0) FROM appointments a
        INNER JOIN users u ON u.id = a.user_id AND u.tenant_id = ?
        INNER JOIN services s ON s.id = a.service_id
        WHERE YEAR(a.appointment_date) = YEAR(CURDATE())
          AND MONTH(a.appointment_date) = MONTH(CURDATE())
          AND a.status NOT IN ('cancelled','cancelled_by_business')
    ");
    $st->execute([$tenantId]);
    $totalRevenue = (float)$st->fetchColumn();

    // This month: cancellations
    $st = $conn->prepare("
        SELECT COUNT(*) FROM appointments a
        INNER JOIN users u ON u.id = a.user_id AND u.tenant_id = ?
        WHERE YEAR(a.appointment_date) = YEAR(CURDATE())
          AND MONTH(a.appointment_date) = MONTH(CURDATE())
          AND a.status IN ('cancelled','cancelled_by_business')
    ");
    $st->execute([$tenantId]);
    $cancellations = (int)$st->fetchColumn();

    // Top workers by bookings (all time)
    $st = $conn->prepare("
        SELECT wu.first_name, wu.last_name, COUNT(*) as cnt
        FROM appointments a
        INNER JOIN users cu ON cu.id = a.user_id AND cu.tenant_id = ?
        INNER JOIN users wu ON wu.id = a.worker_id
        WHERE a.status NOT IN ('cancelled','cancelled_by_business')
          AND a.worker_id IS NOT NULL
        GROUP BY a.worker_id, wu.first_name, wu.last_name
        ORDER BY cnt DESC
        LIMIT 5
    ");
    $st->execute([$tenantId]);
    $topByBookings = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $topByBookings[] = [
            'name'  => trim(trim((string)$row['first_name']) . ' ' . trim((string)$row['last_name'])),
            'count' => (int)$row['cnt'],
        ];
    }

    // Top workers by revenue (all time)
    $st = $conn->prepare("
        SELECT wu.first_name, wu.last_name, COALESCE(SUM(s.price), 0) as rev
        FROM appointments a
        INNER JOIN users cu ON cu.id = a.user_id AND cu.tenant_id = ?
        INNER JOIN users wu ON wu.id = a.worker_id
        INNER JOIN services s ON s.id = a.service_id
        WHERE a.status NOT IN ('cancelled','cancelled_by_business')
          AND a.worker_id IS NOT NULL
        GROUP BY a.worker_id, wu.first_name, wu.last_name
        ORDER BY rev DESC
        LIMIT 5
    ");
    $st->execute([$tenantId]);
    $topByRevenue = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $topByRevenue[] = [
            'name'    => trim(trim((string)$row['first_name']) . ' ' . trim((string)$row['last_name'])),
            'revenue' => (float)$row['rev'],
        ];
    }

    // Top services (all time)
    $st = $conn->prepare("
        SELECT s.name, COUNT(*) as cnt
        FROM appointments a
        INNER JOIN users u ON u.id = a.user_id AND u.tenant_id = ?
        INNER JOIN services s ON s.id = a.service_id
        WHERE a.status NOT IN ('cancelled','cancelled_by_business')
        GROUP BY a.service_id, s.name
        ORDER BY cnt DESC
        LIMIT 5
    ");
    $st->execute([$tenantId]);
    $topServices = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $topServices[] = [
            'name'  => (string)$row['name'],
            'count' => (int)$row['cnt'],
        ];
    }

    // Busiest day of week (all time)
    $st = $conn->prepare("
        SELECT DAYOFWEEK(a.appointment_date) as dow, COUNT(*) as cnt
        FROM appointments a
        INNER JOIN users u ON u.id = a.user_id AND u.tenant_id = ?
        WHERE a.status NOT IN ('cancelled','cancelled_by_business')
        GROUP BY dow ORDER BY cnt DESC LIMIT 1
    ");
    $st->execute([$tenantId]);
    $dayRow = $st->fetch(PDO::FETCH_ASSOC);
    $busiestDay = $dayRow ? ['day' => $hebrewDays[(int)$dayRow['dow']] ?? '', 'count' => (int)$dayRow['cnt']] : null;

    // Busiest time slot (all time)
    $st = $conn->prepare("
        SELECT TIME_FORMAT(a.appointment_time, '%H:00') as slot, COUNT(*) as cnt
        FROM appointments a
        INNER JOIN users u ON u.id = a.user_id AND u.tenant_id = ?
        WHERE a.status NOT IN ('cancelled','cancelled_by_business')
        GROUP BY slot ORDER BY cnt DESC LIMIT 1
    ");
    $st->execute([$tenantId]);
    $timeRow = $st->fetch(PDO::FETCH_ASSOC);
    $busiestTime = $timeRow ? ['time' => (string)$timeRow['slot'], 'count' => (int)$timeRow['cnt']] : null;

    echo json_encode([
        'status'                  => 'success',
        'month_label'             => $monthLabel,
        'this_month'              => [
            'total_bookings' => $totalBookings,
            'total_revenue'  => $totalRevenue,
            'cancellations'  => $cancellations,
        ],
        'top_workers_by_bookings' => $topByBookings,
        'top_workers_by_revenue'  => $topByRevenue,
        'top_services'            => $topServices,
        'busiest_day'             => $busiestDay,
        'busiest_time'            => $busiestTime,
    ], JSON_UNESCAPED_UNICODE);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
