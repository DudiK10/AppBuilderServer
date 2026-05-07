<?php
// backend/api/create_business.php — יצירת רשומת עסק (אדמין בלבד); tenant_id חובה, שאר השדות אופציונליים
require_once __DIR__ . '/db_connect.php';

$rawInput = file_get_contents('php://input');
$data = json_decode($rawInput);
verify_admin($conn, resolve_api_token(is_object($data) ? $data : null));

if (!is_object($data)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'גוף בקשה לא תקין'], JSON_UNESCAPED_UNICODE);
    exit;
}

$dataArr = json_decode($rawInput, true);
if (!is_array($dataArr)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'גוף בקשה לא תקין'], JSON_UNESCAPED_UNICODE);
    exit;
}

$tenantId = isset($dataArr['tenant_id']) ? trim((string) $dataArr['tenant_id']) : '';
if ($tenantId === '') {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'חסר tenant_id'], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $check = $conn->prepare('SELECT id FROM businesses WHERE tenant_id = ? LIMIT 1');
    $check->execute([$tenantId]);
    if ($check->fetch(PDO::FETCH_ASSOC)) {
        http_response_code(409);
        echo json_encode(['status' => 'error', 'message' => 'Business already exists'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $businessName = array_key_exists('businessName', $dataArr)
        ? trim((string) $dataArr['businessName'])
        : '';

    $businessType = 'barber';
    if (array_key_exists('businessType', $dataArr)) {
        $bt = strtolower(trim((string) $dataArr['businessType']));
        if ($bt !== 'barber' && $bt !== 'cosmetician') {
            http_response_code(400);
            echo json_encode(['status' => 'error', 'message' => 'businessType לא תקין'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $businessType = $bt;
    }

    $brandPreset = 'classic_modern';
    if (array_key_exists('brandPreset', $dataArr)) {
        $bp = trim((string) $dataArr['brandPreset']);
        if (strlen($bp) > 50) {
            http_response_code(400);
            echo json_encode(['status' => 'error', 'message' => 'brandPreset ארוך מדי'], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $brandPreset = $bp === '' ? 'classic_modern' : $bp;
    }

    $logoUrl = null;
    if (array_key_exists('logoUri', $dataArr)) {
        $v = $dataArr['logoUri'];
        if ($v === null || $v === '') {
            $logoUrl = null;
        } else {
            $logoUrl = trim((string) $v);
        }
    }

    $bgImageUrl = null;
    if (array_key_exists('bgImageUri', $dataArr)) {
        $v = $dataArr['bgImageUri'];
        if ($v === null || $v === '') {
            $bgImageUrl = null;
        } else {
            $bgImageUrl = trim((string) $v);
        }
    }

    $bgBlurIntensity = 22;
    if (array_key_exists('bgBlurIntensity', $dataArr)) {
        $n = (int) $dataArr['bgBlurIntensity'];
        if ($n < 0) {
            $n = 0;
        }
        if ($n > 255) {
            $n = 255;
        }
        $bgBlurIntensity = $n;
    }

    $aboutUsText = null;
    if (array_key_exists('aboutUsText', $dataArr)) {
        $v = $dataArr['aboutUsText'];
        if ($v === null) {
            $aboutUsText = null;
        } else {
            $aboutUsText = (string) $v;
        }
    }

    $businessPhone = null;
    if (array_key_exists('businessPhone', $dataArr)) {
        $v = $dataArr['businessPhone'];
        if ($v === null || $v === '') {
            $businessPhone = null;
        } else {
            $businessPhone = trim((string) $v);
        }
    }

    $businessAddress = null;
    if (array_key_exists('businessAddress', $dataArr)) {
        $v = $dataArr['businessAddress'];
        if ($v === null || $v === '') {
            $businessAddress = null;
        } else {
            $businessAddress = trim((string) $v);
        }
    }

    $socialInstagram = null;
    $socialFacebook = null;
    $socialTiktok = null;
    $socialWebsite = null;
    $socialWhatsapp = null;

    $varcharMap = [
        'socialInstagram' => 'social_instagram',
        'socialFacebook' => 'social_facebook',
        'socialTiktok' => 'social_tiktok',
        'socialWebsite' => 'social_website',
        'socialWhatsapp' => 'social_whatsapp',
    ];
    foreach ($varcharMap as $jsonKey => $col) {
        if (!array_key_exists($jsonKey, $dataArr)) {
            continue;
        }
        $v = $dataArr[$jsonKey];
        $val = null;
        if ($v !== null && $v !== '') {
            $val = trim((string) $v);
        }
        if ($jsonKey === 'socialInstagram') {
            $socialInstagram = $val;
        } elseif ($jsonKey === 'socialFacebook') {
            $socialFacebook = $val;
        } elseif ($jsonKey === 'socialTiktok') {
            $socialTiktok = $val;
        } elseif ($jsonKey === 'socialWebsite') {
            $socialWebsite = $val;
        } elseif ($jsonKey === 'socialWhatsapp') {
            $socialWhatsapp = $val;
        }
    }

    $galleryUrisJson = null;
    if (array_key_exists('galleryUris', $dataArr)) {
        $v = $dataArr['galleryUris'];
        if ($v === null) {
            $galleryUrisJson = null;
        } elseif (!is_array($v)) {
            http_response_code(400);
            echo json_encode(['status' => 'error', 'message' => 'galleryUris חייב להיות מערך או null'], JSON_UNESCAPED_UNICODE);
            exit;
        } else {
            $urls = [];
            foreach ($v as $item) {
                if (is_string($item) && trim($item) !== '') {
                    $urls[] = trim($item);
                }
            }
            $galleryUrisJson = json_encode($urls, JSON_UNESCAPED_UNICODE);
        }
    }

    $sql = 'INSERT INTO businesses (
        tenant_id, business_name, business_type, brand_preset,
        logo_url, bg_image_url, bg_blur_intensity,
        about_us_text, business_phone, business_address,
        social_instagram, social_facebook, social_tiktok, social_website, social_whatsapp,
        gallery_uris
    ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?
    )';

    $ins = $conn->prepare($sql);
    $ins->execute([
        $tenantId,
        $businessName,
        $businessType,
        $brandPreset,
        $logoUrl,
        $bgImageUrl,
        $bgBlurIntensity,
        $aboutUsText,
        $businessPhone,
        $businessAddress,
        $socialInstagram,
        $socialFacebook,
        $socialTiktok,
        $socialWebsite,
        $socialWhatsapp,
        $galleryUrisJson,
    ]);

    echo json_encode(['status' => 'success', 'tenant_id' => $tenantId], JSON_UNESCAPED_UNICODE);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'שגיאת שרת: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
}
