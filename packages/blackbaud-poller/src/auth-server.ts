/**
 * Blackbaud OAuth 2.0 Authorization Code Flow
 *
 * Run once to obtain a refresh token. Saves to .env automatically.
 *
 * Prerequisites:
 * 1. Register your app at https://developer.blackbaud.com/skyapi/applications/createapp
 * 2. Add redirect URI: http://localhost:3001/bb-callback (or your port)
 * 3. Set BLACKBAUD_CLIENT_ID, BLACKBAUD_CLIENT_SECRET in .env
 *
 * Usage: npm run auth -w @fm-sync/blackbaud-poller
 * Then open http://localhost:3001 in your browser.
 */
import { config as loadEnv } from 'dotenv';
import path from 'path';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHash, randomBytes } from 'crypto';
import { createLogger } from '@fm-sync/shared';
import { storeRefreshToken } from './blackbaud-client';

// Load .env from project root (monorepo root)
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

const log = createLogger('blackbaud-auth', 'bb');
import { URL } from 'url';

const PORT = parseInt(process.env.BB_AUTH_PORT || '3001', 10);
const AUTH_URL = 'https://app.blackbaud.com/oauth/authorize';
const TOKEN_URL = 'https://oauth2.sky.blackbaud.com/token';

// PKCE: generate code_verifier (43-128 chars)
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

// PKCE: code_challenge = base64url(sha256(code_verifier))
function getCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const pendingAuth = new Map<string, { verifier: string; redirectUri: string }>();

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;max-width:600px;margin:2rem auto;padding:1rem">${body}</body></html>`;
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string
): Promise<{ refresh_token: string; access_token: string; expires_in: number }> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return (await res.json()) as { refresh_token: string; access_token: string; expires_in: number };
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname === '/' && req.method === 'GET') {
    const clientId = process.env.BLACKBAUD_CLIENT_ID;
    const clientSecret = process.env.BLACKBAUD_CLIENT_SECRET;
    const redirectUri = process.env.BB_AUTH_REDIRECT_URI || `http://localhost:${PORT}/bb-callback`;

    if (!clientId || !clientSecret) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        htmlPage(
          'Blackbaud OAuth - Missing Config',
          `
          <h1>Missing Configuration</h1>
          <p>Add to .env:</p>
          <pre>BLACKBAUD_CLIENT_ID=your-app-id
BLACKBAUD_CLIENT_SECRET=your-app-secret</pre>
          <p>Register your app at <a href="https://developer.blackbaud.com/skyapi/applications/createapp">Blackbaud Developer Portal</a> and add redirect URI: <code>${redirectUri}</code></p>
        `
        )
      );
      return;
    }

    const state = randomBytes(16).toString('hex');
    const verifier = generateCodeVerifier();
    const challenge = getCodeChallenge(verifier);
    pendingAuth.set(state, { verifier, redirectUri });

    const authParams = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const authLink = `${AUTH_URL}?${authParams.toString()}`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      htmlPage(
        'Blackbaud OAuth',
        `
        <h1>Connect to Blackbaud</h1>
        <p>Click below to authorize this app and obtain a refresh token.</p>
        <p><a href="${authLink}" style="display:inline-block;background:#0078d4;color:white;padding:0.5rem 1rem;text-decoration:none;border-radius:4px">Authorize with Blackbaud</a></p>
        <p><small>Redirect URI registered in your app must be: <code>${redirectUri}</code></small></p>
      `
        )
    );
    return;
  }

  if (url.pathname === '/bb-callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        htmlPage(
          'Authorization Denied',
          `<h1>Authorization failed</h1><p>Error: ${error}</p><p><a href="/">Try again</a></p>`
        )
      );
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Error', '<h1>Missing code or state</h1><p><a href="/">Start over</a></p>'));
      return;
    }

    const pending = pendingAuth.get(state);
    pendingAuth.delete(state);
    if (!pending) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(htmlPage('Error', '<h1>Invalid or expired state</h1><p><a href="/">Start over</a></p>'));
      return;
    }

    const clientId = process.env.BLACKBAUD_CLIENT_ID!;
    const clientSecret = process.env.BLACKBAUD_CLIENT_SECRET!;

    exchangeCodeForTokens(code, pending.redirectUri, pending.verifier, clientId, clientSecret)
      .then((tokens) => {
        storeRefreshToken(tokens.refresh_token);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          htmlPage(
            'Success - Token Saved',
            `
            <h1>Tokens obtained and saved</h1>
            <p>The refresh token has been saved to <code>.env</code>. The poller will use it automatically.</p>
            <p>You only need to run this OAuth flow again if the token is revoked or expires from inactivity.</p>
            <p><a href="/">Get new tokens</a></p>
          `
            )
        );
      })
      .catch((err) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          htmlPage(
            'Token Exchange Failed',
            `<h1>Error</h1><pre>${String(err.message)}</pre><p><a href="/">Try again</a></p>`
          )
        );
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

const server = createServer(handleRequest);
server.listen(PORT, () => {
  log.info({ url: `http://localhost:${PORT}` }, 'OAuth server ready');
  log.info('Open in browser, click "Authorize", then copy the refresh token to .env');
});
