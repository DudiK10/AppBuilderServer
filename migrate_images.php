<?php
/**
 * migrate_images.php — one-time migration script
 * Upload to: Hostinger → public_html/ (same folder as get_lookbook.php)
 * Run at:    https://manageapp.in/migrate_images.php?secret=migrate2026
 * Delete after running.
 */

if (($_GET['secret'] ?? '') !== 'migrate2026') {
    http_response_code(403);
    die('Forbidden');
}

ini_set('display_errors', 1);
error_reporting(E_ALL);
set_time_limit(300);

require_once __DIR__ . '/db_connect.php';

header('Content-Type: text/plain; charset=utf-8');

$OLD_DOMAIN  = 'domain-app2.cloud';
$NEW_DOMAIN  = 'manageapp.in';
$UPLOAD_DIR  = __DIR__ . '/uploads/';

if (!is_dir($UPLOAD_DIR)) {
    mkdir($UPLOAD_DIR, 0755, true);
}

$results = ['migrated' => [], 'skipped' => [], 'failed' => []];

function download_and_save(string $url, string $uploadDir): string|false {
    $ctx = stream_context_create(['http' => ['timeout' => 20]]);
    $content = @file_get_contents($url, false, $ctx);
    if ($content === false || strlen($content) < 100) return false;

    $urlPath = parse_url($url, PHP_URL_PATH);
    $rel = preg_replace('#^/?uploads/#', '', ltrim($urlPath, '/'));
    $ext = strtolower(pathinfo($rel, PATHINFO_EXTENSION));
    if (!in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'], true)) $ext = 'jpg';
    if (!$rel) $rel = 'migrated_' . uniqid() . '.' . $ext;

    $destAbs = $uploadDir . $rel;
    $destDir = dirname($destAbs);
    if (!is_dir($destDir)) mkdir($destDir, 0755, true);
    if (file_put_contents($destAbs, $content) === false) return false;
    return $rel;
}

function new_url(string $rel): string {
    global $NEW_DOMAIN;
    return 'https://' . $NEW_DOMAIN . '/uploads/' . $rel;
}

echo "=== staff_profiles.avatar_url ===\n";
$rows = $conn->query("SELECT worker_id, avatar_url FROM staff_profiles WHERE avatar_url LIKE '%{$OLD_DOMAIN}%'")->fetchAll(PDO::FETCH_ASSOC);
echo "Found " . count($rows) . " rows\n";
foreach ($rows as $row) {
    $oldUrl = $row['avatar_url'];
    echo "  worker_id={$row['worker_id']} → {$oldUrl}\n";
    $rel = download_and_save($oldUrl, $UPLOAD_DIR);
    if ($rel === false) { echo "  FAILED\n"; $results['failed'][] = $oldUrl; continue; }
    $newUrl = new_url($rel);
    $conn->prepare('UPDATE staff_profiles SET avatar_url = ? WHERE worker_id = ?')->execute([$newUrl, $row['worker_id']]);
    echo "  OK → {$newUrl}\n";
    $results['migrated'][] = $oldUrl;
}

echo "\n=== portfolio_items.image_url ===\n";
$rows = $conn->query("SELECT id, worker_id, image_url FROM portfolio_items WHERE image_url LIKE '%{$OLD_DOMAIN}%'")->fetchAll(PDO::FETCH_ASSOC);
echo "Found " . count($rows) . " rows\n";
foreach ($rows as $row) {
    $oldUrl = $row['image_url'];
    echo "  item id={$row['id']} → {$oldUrl}\n";
    $rel = download_and_save($oldUrl, $UPLOAD_DIR);
    if ($rel === false) { echo "  FAILED\n"; $results['failed'][] = $oldUrl; continue; }
    $newUrl = new_url($rel);
    $conn->prepare('UPDATE portfolio_items SET image_url = ? WHERE id = ?')->execute([$newUrl, $row['id']]);
    echo "  OK → {$newUrl}\n";
    $results['migrated'][] = $oldUrl;
}

echo "\n=== SUMMARY ===\n";
echo "Migrated: " . count($results['migrated']) . "\n";
echo "Failed:   " . count($results['failed']) . "\n";
if (!empty($results['failed'])) { echo "\nFailed:\n"; foreach ($results['failed'] as $u) echo "  $u\n"; }
echo "\nDone. DELETE this file from the server now.\n";
