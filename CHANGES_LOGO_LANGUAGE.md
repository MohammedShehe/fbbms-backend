# Update: business logos + Swahili/English

## Deploy
1. Replace the backend files with this zip's files (keep your own `.env` and `node_modules`).
2. `npm run migrate` — adds `users.language`. (If you forget, the server adds the column itself on start.)
3. Restart the server. No new environment variables are needed (logos use your existing Cloudinary settings).

## Business logo (Super Admin → *Shop & website* · Developer → *Businesses → Edit*)
- `POST /api/b/logo {data}` · `DELETE /api/b/logo` — Super Admin of the current business.
- `POST|DELETE /api/developer/businesses/:id/logo` — Developer, any business.
- JPEG/PNG/WebP only, real file-signature check, max 2 MB. Stored on Cloudinary in `fbbms/<slug>/logo`; the old file is deleted when replaced/removed.
- Saved in `businesses.theme` (`logo_url`, `logo_public_id`). Public API (`/public/:slug`, `/v1/business`) now returns `theme.logo_url`.
- The logo can only be changed through these endpoints (logo keys are stripped from generic theme updates).

## Language
- `users.language` (`en`/`sw`/NULL = follow default). `PUT /api/auth/language`.
- `businesses.settings.language` — default for a business (Super Admin, Shop & website → Language).
- `platform_settings.platform.default_language` — platform default (Developer → Platform theme). Also returned by `/api/platform/theme` for the login page.
- Order used: personal → business → platform → English. OTP e-mails are sent in the user's language.
