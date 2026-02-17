/**
 * PM2 ecosystem file for production.
 * Run from repo root after building:
 *   npm run build -w @fm-sync/hubspot-poller && npm run build -w @fm-sync/blackbaud-poller
 *   pm2 start ecosystem.config.cjs
 *
 * Load .env from repo root (set cwd so pollers find .env).
 */
const path = require('path');
const root = path.resolve(__dirname);

module.exports = {
  apps: [
    {
      name: 'hubspot-poller',
      script: path.join(root, 'packages/hubspot-poller/dist/index.js'),
      cwd: root,
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'blackbaud-poller',
      script: path.join(root, 'packages/blackbaud-poller/dist/index.js'),
      cwd: root,
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
