# App Factory Studio

A Node.js server with a Hebrew admin panel that generates customized mobile apps for businesses. Enter business details, upload assets, sync with API, and trigger an automated Expo build flow—all from one interface.

## Overview

App Factory Studio is an **automated app generation system** designed for beauty salons and cosmetic businesses. Each tenant gets a branded mobile app (iOS/Android) built from a shared Expo codebase with customized branding, themes, and configuration.

## Features

- **Business Setup Form** - Configure app name, tenant ID, bundle ID, and business type (salon/cosmetics)
- **Asset Management** - Upload app icon (required) and splash screen logo (optional)
- **Live Preview** - Real-time iframe preview of the app running on local Expo server
- **API Integration** - Syncs business data with PHP backend and updates Expo project config
- **Automated Builds** - Triggers build pipeline via `/api/build-app` endpoint with environment-based secrets

## Tech Stack

**Frontend (Admin Panel):** HTML, JavaScript, Tailwind CSS (CDN), RTL support, Assistant font  
**Backend:** Node.js, Express, Multer (file uploads), proxy to PHP API  
**External API:** PHP (MySQL via PDO for business management)  
**Mobile Output:** Expo / React Native (separate project directory)

## Getting Started

```bash
# Clone and install
git clone https://github.com/yourusername/app-builder-server.git
cd app-builder-server
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with:
# PHP_API_BASE=http://your-php-server.com
# ADMIN_API_TOKEN=your_secret_token
# PORT=3000

# Run the server
npm start

# Access admin panel
# Open http://localhost:3000 in browser
```

## Environment Variables

```env
PHP_API_BASE=http://api.example.com       # PHP backend URL
ADMIN_API_TOKEN=your_admin_token          # API authentication token
PORT=3000                                 # Server port
EXPO_PROJECT_PATH=/path/to/expo-project   # Local Expo project directory
```

## How It Works

1. **Admin fills form** - Business details, tenant ID, branding assets
2. **Server processes** - Multer handles uploads, validates, converts assets
3. **API sync** - Creates/updates business record via `/api/create_business.php`
4. **Config update** - Modifies Expo project's `app.json` and asset files on disk
5. **Build trigger** - Runs `eas build` or similar CLI commands for iOS/Android

## Why I Built This

App Factory Studio demonstrates **full-stack integration** between a web admin panel, Node.js orchestration, external PHP API, and mobile app generation. Built as a portfolio piece to showcase:

- Complex file handling and multipart uploads
- API authentication and proxying patterns
- CLI automation and build pipelines
- Multi-tenant configuration management

## Key Challenge Solved

**End-to-end automation flow** - Accepting form data + files via Multer, converting/storing assets, dynamically updating Expo project config on disk, and integrating with admin authentication on a separate PHP backend—while keeping secrets in `.env` and maintaining a smooth RTL Hebrew UX.

## Project Structure
app-builder-server/
├── public/              # Admin panel HTML/CSS/JS
├── uploads/             # Temporary file storage
├── routes/              # Express API routes
├── services/            # Business logic (file handling, API calls)
├── .env.example         # Environment template
└── server.js            # Main Express server

## Security Notes

- Admin authentication via `ADMIN_API_TOKEN`
- Secrets managed through environment variables (never committed)
- File upload validation and size limits
- CORS configuration for trusted origins
