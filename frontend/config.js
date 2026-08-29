/**
 * Deploy-time configuration for the static frontend.
 *
 * If you host the backend on the SAME origin as this file (e.g. the Express
 * server serves both, as in local dev via `npm start`), leave this as ''.
 *
 * If you host this frontend as static files (Vercel, Netlify, GitHub Pages,
 * S3, etc.) SEPARATELY from the backend (Render, Railway, Fly.io, an EC2
 * box, etc.) — which is the normal way to deploy this project — set this to
 * your backend's full URL, e.g.:
 *
 *   window.API_BASE = 'https://tnpsc-backend.onrender.com';
 *
 * Do NOT put a trailing slash. See README.md -> "Deployment" for the full
 * walkthrough, including why leaving this blank on a static-only host is
 * the #1 cause of "Page Not Found" / failed-upload errors.
 */
window.API_BASE = '';
