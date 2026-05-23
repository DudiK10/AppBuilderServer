<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

// backend/api/get_lookbook.php — Lookbook ציבורי (ללא Auth)
// טבלאות: users + staff_profiles (ביו/אווטאר), portfolio_items (גלריה), reviews (דירוגים והצגה)

require_once __DIR__ . '/db_connect.php';

header('Content-Type: application/json; charset=utf-8');

function rewrite_cdn_url(string $url): string {
    return str_replace('https://domain-app2.cloud', 'https://manageapp.in', $url);
}

$filterWorkerId = null;
if (isset($_GET['worker_id'])) {
    $w = (int) $_GET['worker_id'];
    $filterWorkerId = $w > 0 ? $w : null;
}

$filterTenantId = null;
if (isset($_GET['tenant_id'])) {
    $t = trim((string) $_GET['tenant_id']);
    $filterTenantId = $t !== '' ? $t : null;
}

/**
 * @param array<string, mixed> $row
 */
function lookbook_display_name(array $row): string
{
    $fn = trim((string) ($row['first_name'] ?? ''));
    $ln = trim((string) ($row['last_name'] ?? ''));
    $name = trim($fn . ' ' . $ln);
    return $name !== '' ? $name : ('חבר צוות #' . (int) ($row['id'] ?? 0));
}

/**
 * @return array<int, string>
 */
function lookbook_tags_to_array(?string $tags): array
{
    if ($tags === null || trim($tags) === '') return [];
    $parts = preg_split('/\s*,\s*/', trim($tags));
    return array_values(array_filter(array_map('trim', $parts)));
}

try {
    $sql = "
        SELECT u.id, u.phone, u.first_name, u.last_name, u.role,
               sp.bio, sp.avatar_url
        FROM users u
        LEFT JOIN staff_profiles sp ON sp.worker_id = u.id
        WHERE LOWER(TRIM(u.role)) IN ('worker', 'admin')
    ";
    $params = [];
    if ($filterTenantId !== null) {
        $sql .= ' AND u.tenant_id = :tid';
        $params[':tid'] = $filterTenantId;
    }
    if ($filterWorkerId !== null) {
        $sql .= ' AND u.id = :wid';
        $params[':wid'] = $filterWorkerId;
    }
    $sql .= ' ORDER BY u.id ASC';

    $st = $conn->prepare($sql);
    $st->execute($params);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);

    $staff = [];

    foreach ($rows as $row) {
        $workerId = (int) $row['id'];
        $displayName = lookbook_display_name($row);
        $bioRaw = trim((string) ($row['bio'] ?? ''));
        $bioPlaceholders = [
            'ספר/מעצב שיער — תיאור יופיע כאן עד לעדכון הפרופיל.',
            'מקצוען עם ניסיון — עדכנו ביו בפאנל הניהול.',
            'מקצוענית עם ניסיון — עדכנו ביו בפאנל הניהול.',
        ];
        $bio = ($bioRaw === '' || in_array($bioRaw, $bioPlaceholders, true)) ? '' : $bioRaw;
        $avatarRaw = isset($row['avatar_url']) ? trim((string) $row['avatar_url']) : '';
        $avatarUrl = $avatarRaw !== ''
            ? rewrite_cdn_url($avatarRaw)
            : ('https://ui-avatars.com/api/?name=' . rawurlencode($displayName) . '&background=random&size=256');

        // ── reviews: avg rating — filtered by customer's tenant ───────────────
        // reviews table has no tenant_id column — filter via the customer's tenant
        if ($filterTenantId !== null) {
            $avgSt = $conn->prepare(
                "SELECT AVG(r.rating) AS av, COUNT(*) AS cnt
                 FROM reviews r
                 INNER JOIN users cu ON cu.id = r.customer_id AND cu.tenant_id = ?
                 WHERE r.worker_id = ? AND r.status = 'approved'"
            );
            $avgSt->execute([$filterTenantId, $workerId]);
        } else {
            $avgSt = $conn->prepare(
                "SELECT AVG(rating) AS av, COUNT(*) AS cnt FROM reviews
                 WHERE worker_id = ? AND status = 'approved'"
            );
            $avgSt->execute([$workerId]);
        }
        $avgRow = $avgSt->fetch(PDO::FETCH_ASSOC);
        $avg = $avgRow && $avgRow['av'] !== null ? round((float) $avgRow['av'], 1) : null;
        $reviewCount = (int) ($avgRow['cnt'] ?? 0);

        // ── portfolio_items — global per worker (no tenant_id column) ─────────
        $portSt = $conn->prepare(
            'SELECT id, image_url, description, tags, created_at
             FROM portfolio_items WHERE worker_id = ? ORDER BY id ASC'
        );
        $portSt->execute([$workerId]);
        $portfolioRaw = $portSt->fetchAll(PDO::FETCH_ASSOC);
        $portfolio = [];
        foreach ($portfolioRaw as $p) {
            $portfolio[] = [
                'id'          => (int) $p['id'],
                'image_url'   => rewrite_cdn_url((string) $p['image_url']),
                'description' => (string) ($p['description'] ?? ''),
                'tags'        => lookbook_tags_to_array(isset($p['tags']) ? (string) $p['tags'] : null),
                'created_at'  => (string) ($p['created_at'] ?? ''),
            ];
        }

        // ── reviews: list — filtered by customer's tenant ─────────────────────
        if ($filterTenantId !== null) {
            $revSt = $conn->prepare(
                "SELECT r.id, r.rating, r.review_text, r.created_at,
                        cu.first_name AS cf, cu.last_name AS cl
                 FROM reviews r
                 INNER JOIN users cu ON cu.id = r.customer_id AND cu.tenant_id = ?
                 WHERE r.worker_id = ? AND r.status = 'approved'
                 ORDER BY r.created_at DESC
                 LIMIT 50"
            );
            $revSt->execute([$filterTenantId, $workerId]);
        } else {
            $revSt = $conn->prepare(
                "SELECT r.id, r.rating, r.review_text, r.created_at,
                        cu.first_name AS cf, cu.last_name AS cl
                 FROM reviews r
                 INNER JOIN users cu ON cu.id = r.customer_id
                 WHERE r.worker_id = ? AND r.status = 'approved'
                 ORDER BY r.created_at DESC
                 LIMIT 50"
            );
            $revSt->execute([$workerId]);
        }
        $reviewsRaw = $revSt->fetchAll(PDO::FETCH_ASSOC);
        $reviews = [];
        foreach ($reviewsRaw as $r) {
            $cn = trim(trim((string) ($r['cf'] ?? '')) . ' ' . trim((string) ($r['cl'] ?? '')));
            if ($cn === '') $cn = 'לקוח';
            $reviews[] = [
                'id'            => (int) $r['id'],
                'rating'        => (int) $r['rating'],
                'review_text'   => (string) ($r['review_text'] ?? ''),
                'customer_name' => $cn,
                'created_at'    => (string) ($r['created_at'] ?? ''),
            ];
        }

        $staff[] = [
            'id'           => $workerId,
            'phone'        => (string) ($row['phone'] ?? ''),
            'display_name' => $displayName,
            'role'         => (string) ($row['role'] ?? ''),
            'bio'          => $bio,
            'avatar_url'   => $avatarUrl,
            'avg_rating'   => $avg,
            'review_count' => $reviewCount,
            'portfolio'    => $portfolio,
            'reviews'      => $reviews,
        ];
    }

    echo json_encode([
        'status' => 'success',
        'staff'  => $staff,
    ], JSON_UNESCAPED_UNICODE);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'DB Error: ' . $e->getMessage(),
        'line'    => $e->getLine(),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}
