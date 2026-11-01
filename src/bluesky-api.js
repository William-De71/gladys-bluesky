// -----------------------------------------------------------------------------
// The XRPC client of the integration: the official HTTP API of the AT Protocol
// (https://docs.bsky.app, lexicons of bluesky-social/atproto).
//
// Session (com.atproto.server.*):
//   - createSession with the identifier and the app password, ONCE: the PDS
//     allows 30 per 5 minutes and 300 per day and per account. The tokens
//     (accessJwt, refreshJwt), the DID and the PDS URL are kept in /data
//     (src/session-store.js) and survive a restart;
//   - the access token is renewed with refreshSession (the refresh token
//     rotates), a few minutes before it expires or on ExpiredToken; a new
//     createSession only when the refresh token is refused;
//   - a refused password is never retried on its own: only a new
//     configuration or the "Test the connection" button try again.
//
// Every later call goes to the PDS of the account, read from the DID document
// that createSession returns (service #atproto_pds): bsky.social is only the
// entryway. The direct messages (chat.bsky.*) go through the same PDS with
// the header `atproto-proxy: did:web:api.bsky.chat#bsky_chat`.
//
// Rate limits: the `ratelimit-remaining` / `ratelimit-reset` headers and 429
// answers pause the calls until the reset (createSession apart from the rest).
// Errors are XrpcError objects with a `reason` the app maps to a status, a
// scene event or a message: never the password nor a token in them.
// -----------------------------------------------------------------------------

import { DEFAULT_SERVICE } from './config.js';

const CHAT_PROXY = 'did:web:api.bsky.chat#bsky_chat';
const DEFAULT_TIMEOUT_MS = 15_000;
// Renew the access token this long before it expires.
const REFRESH_MARGIN_MS = 5 * 60_000;
// Longest pause after a 429 without a usable `ratelimit-reset`, and the cap of
// any pause (a reset a day away still lets "Test the connection" retry).
const DEFAULT_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 6 * 3600_000;

// Lexicon error names -> the reason the app understands.
const REASONS = {
  AuthenticationRequired: 'auth',
  AuthFactorTokenRequired: 'two_factor',
  AccountTakedown: 'account',
  AccountDeactivated: 'account',
  AccountSuspended: 'account',
  HandleNotFound: 'not_found',
  RecordNotFound: 'not_found',
  NotFound: 'not_found',
  RecipientNotFound: 'recipient',
  MessagesDisabled: 'recipient',
  NotFollowedBySender: 'recipient',
  BlockedActor: 'recipient',
  BlockedSubject: 'recipient',
  ConvoLocked: 'recipient',
  InvalidConvo: 'recipient',
  RateLimitExceeded: 'rate_limited',
};

class XrpcError extends Error {
  /**
   * @param {object} details - What went wrong.
   * @param {string} details.reason - auth, two_factor, account, dm_scope,
   *   recipient, not_found, invalid, rate_limited, network, server, config.
   * @param {string} [details.code] - The lexicon error name or HTTP status.
   * @param {number} [details.status] - The HTTP status.
   * @param {string} [details.method] - The XRPC method.
   * @param {string} [details.detail] - The message of the server.
   * @param {number} [details.retryAt] - When a rate limit ends, in ms.
   */
  constructor({ reason, code, status, method, detail, retryAt }) {
    super(`${method ?? 'xrpc'}: ${code ?? reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'XrpcError';
    this.reason = reason;
    this.code = code ?? reason;
    this.status = status ?? null;
    this.method = method ?? null;
    this.detail = detail ?? '';
    this.retryAt = retryAt ?? null;
  }
}

/**
 * @description The expiry of a JWT (its `exp` claim), without checking the
 * signature: only to know when to renew it.
 * @param {string} jwt - The token.
 * @returns {number|null} The expiry in ms.
 */
function jwtExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString());
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * @description Whether a URL may receive the tokens: https, or http on the
 * local machine when the configured server is local too (tests).
 * @param {string} url - The URL.
 * @param {string} service - The configured server.
 * @returns {string|null} The origin, null when refused.
 */
function allowedOrigin(url, service) {
  try {
    const parsed = new URL(url);
    const local = (host) => ['127.0.0.1', 'localhost', '[::1]'].includes(host);
    if (parsed.protocol === 'https:') {
      return parsed.origin;
    }
    if (parsed.protocol === 'http:' && local(parsed.hostname) && local(new URL(service).hostname)) {
      return parsed.origin;
    }
  } catch {
    // refused below
  }
  return null;
}

/**
 * @description The PDS of an account, from the DID document createSession
 * returns (service `#atproto_pds`, type AtprotoPersonalDataServer).
 * @param {object} didDoc - The DID document.
 * @param {string} service - The configured server (fallback).
 * @returns {string} The PDS origin.
 */
function pdsOf(didDoc, service) {
  const services = Array.isArray(didDoc?.service) ? didDoc.service : [];
  const entry = services.find(
    (item) =>
      typeof item?.id === 'string' &&
      item.id.endsWith('#atproto_pds') &&
      typeof item.serviceEndpoint === 'string',
  );
  return (entry && allowedOrigin(entry.serviceEndpoint, service)) || service;
}

/**
 * @description When a rate limit ends, from the headers of a response.
 * @param {Headers} headers - The headers.
 * @param {number} now - Now, in ms.
 * @returns {number|null} The instant, in ms.
 */
function resetOf(headers, now) {
  const reset = Number(headers.get('ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // The draft allows seconds from now; Bluesky sends an epoch in seconds.
    return reset > 1e9 ? reset * 1000 : now + reset * 1000;
  }
  const after = Number(headers.get('retry-after'));
  return Number.isFinite(after) && after > 0 ? now + after * 1000 : null;
}

/**
 * @description Create the client.
 * @param {object} [options] - Options.
 * @param {Function} [options.fetchImpl] - fetch.
 * @param {() => number} [options.now] - Clock, in ms.
 * @param {object} [options.sessionStore] - load() / save(session) / clear().
 * @param {number} [options.timeoutMs] - Timeout of a request.
 * @param {object} [options.logger] - Logger.
 * @returns {object} The client.
 * @example
 * const api = createBlueskyApi({ sessionStore, logger });
 * api.configure({ identifier: 'home.bsky.social', appPassword, service: 'https://bsky.social' });
 * await api.getProfile('bsky.app');
 */
function createBlueskyApi({
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  sessionStore = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  let credentials = null; // { identifier, appPassword, service }
  let session = null; // { did, handle, accessJwt, refreshJwt, pdsUrl, service, identifier }
  let loginRefused = null; // an XrpcError: a refused password is not retried alone
  let renewing = null;
  const pauses = { session: 0, api: 0, chat: 0 };

  const fingerprintOf = (creds) => `${creds.service}|${creds.identifier}`;
  const bucketOf = (method, proxy) =>
    method === 'com.atproto.server.createSession' ? 'session' : proxy ? 'chat' : 'api';

  /**
   * @description One HTTP request, with the rate limit bookkeeping.
   * @param {object} request - The request.
   * @returns {Promise<any>} The JSON body (or {} when empty).
   */
  async function send({ base, method, http, params, body, bytes, contentType, token, proxy }) {
    const bucket = bucketOf(method, proxy);
    if (pauses[bucket] > now()) {
      throw new XrpcError({
        reason: 'rate_limited',
        code: 'RateLimitExceeded',
        method,
        retryAt: pauses[bucket],
      });
    }
    const url = new URL(`/xrpc/${method}`, base);
    for (const [key, value] of Object.entries(params ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      }
    }
    const headers = { accept: 'application/json' };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    if (proxy) {
      headers['atproto-proxy'] = CHAT_PROXY;
    }
    let payload;
    if (bytes) {
      headers['content-type'] = contentType;
      payload = bytes;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method: http,
        headers,
        body: payload,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new XrpcError({
        reason: 'network',
        code: err?.name === 'TimeoutError' ? 'timeout' : 'network',
        method,
        detail: err?.cause?.code ?? '',
      });
    }
    const remaining = Number(response.headers.get('ratelimit-remaining'));
    const reset = resetOf(response.headers, now());
    if (response.headers.has('ratelimit-remaining') && remaining <= 0 && reset) {
      pauses[bucket] = Math.min(reset, now() + MAX_PAUSE_MS);
    }
    const raw = await response.text().catch(() => '');
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    if (response.ok) {
      return data;
    }
    const code = typeof data.error === 'string' ? data.error : String(response.status);
    const detail = typeof data.message === 'string' ? data.message.slice(0, 200) : '';
    if (response.status === 429) {
      pauses[bucket] = Math.min(reset ?? now() + DEFAULT_PAUSE_MS, now() + MAX_PAUSE_MS);
      throw new XrpcError({
        reason: 'rate_limited',
        code: 'RateLimitExceeded',
        status: 429,
        method,
        detail,
        retryAt: pauses[bucket],
      });
    }
    let reason = REASONS[code];
    if (!reason) {
      if (code === 'InvalidToken' && /Bad token (method|scope)/.test(detail)) {
        // An app password without "Allow access to your direct messages"
        // (social-app: isErrorMaybeAppPasswordPermissions).
        reason = 'dm_scope';
      } else if (code === 'ExpiredToken' || code === 'InvalidToken') {
        reason = 'expired';
      } else if (response.status === 401) {
        reason = 'auth';
      } else if (response.status === 403) {
        reason = 'forbidden';
      } else if (response.status === 404) {
        reason = 'not_found';
      } else if (response.status >= 500) {
        reason = 'server';
      } else {
        reason = 'invalid';
      }
    }
    throw new XrpcError({ reason, code, status: response.status, method, detail });
  }

  /**
   * @description Keep a session from createSession / refreshSession.
   * @param {object} data - Their output.
   * @param {string} [pdsUrl] - The PDS (else read in the DID document).
   */
  function keep(data, pdsUrl) {
    if (typeof data?.accessJwt !== 'string' || typeof data?.did !== 'string') {
      throw new XrpcError({ reason: 'server', code: 'BadSession', method: 'session' });
    }
    session = {
      did: data.did,
      handle: typeof data.handle === 'string' ? data.handle : (session?.handle ?? data.did),
      accessJwt: data.accessJwt,
      refreshJwt: data.refreshJwt,
      pdsUrl: data.didDoc ? pdsOf(data.didDoc, credentials.service) : pdsUrl,
      fingerprint: fingerprintOf(credentials),
      active: data.active !== false,
      status: typeof data.status === 'string' ? data.status : null,
    };
    Promise.resolve(sessionStore?.save(session)).catch((err) =>
      logger.warn(`Unable to keep the Bluesky session: ${err.message}`),
    );
  }

  /**
   * @description Open a session with the app password (createSession).
   * @returns {Promise<object>} The session.
   */
  async function login() {
    if (!credentials) {
      throw new XrpcError({ reason: 'config', code: 'NotConfigured', method: 'createSession' });
    }
    try {
      const data = await send({
        base: credentials.service,
        method: 'com.atproto.server.createSession',
        http: 'POST',
        body: { identifier: credentials.identifier, password: credentials.appPassword },
      });
      loginRefused = null;
      keep(data, credentials.service);
      logger.info(`Bluesky session opened for @${session.handle} on ${session.pdsUrl}`);
      return session;
    } catch (err) {
      if (['auth', 'two_factor', 'account', 'invalid'].includes(err.reason)) {
        loginRefused = err;
        session = null;
        await Promise.resolve(sessionStore?.clear()).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * @description Renew the access token (refreshSession), or open a new
   * session when the refresh token is refused. One renewal at a time.
   * @returns {Promise<object>} The session.
   */
  function renew() {
    if (!renewing) {
      renewing = (async () => {
        try {
          const data = await send({
            base: session.pdsUrl,
            method: 'com.atproto.server.refreshSession',
            http: 'POST',
            token: session.refreshJwt,
          });
          keep(data, session.pdsUrl);
          return session;
        } catch (err) {
          if (['expired', 'auth', 'invalid', 'forbidden'].includes(err.reason)) {
            logger.info('Bluesky refresh token refused: opening a new session');
            session = null;
            return login();
          }
          throw err;
        }
      })().finally(() => {
        renewing = null;
      });
    }
    return renewing;
  }

  /**
   * @description A session ready for a call.
   * @returns {Promise<object>} The session.
   */
  async function ready() {
    if (!credentials) {
      throw new XrpcError({ reason: 'config', code: 'NotConfigured', method: 'session' });
    }
    if (!session && sessionStore) {
      const stored = await Promise.resolve(sessionStore.load()).catch(() => null);
      if (stored?.fingerprint === fingerprintOf(credentials) && stored.accessJwt) {
        session = stored;
      }
    }
    if (!session) {
      if (loginRefused) {
        throw loginRefused;
      }
      return login();
    }
    const expiry = jwtExpiry(session.accessJwt);
    if (expiry && expiry - REFRESH_MARGIN_MS < now()) {
      return renew();
    }
    return session;
  }

  /**
   * @description An authenticated XRPC call to the PDS of the account
   * (renews the session once on ExpiredToken).
   * @param {string} method - The NSID.
   * @param {object} [options] - http (GET), params, body, bytes, contentType, proxy.
   * @returns {Promise<any>} The output.
   */
  async function call(method, options = {}) {
    const current = await ready();
    const request = { http: 'GET', ...options, method };
    try {
      return await send({ ...request, base: current.pdsUrl, token: current.accessJwt });
    } catch (err) {
      if (err.reason !== 'expired') {
        throw err;
      }
      const fresh = await renew();
      return send({ ...request, base: fresh.pdsUrl, token: fresh.accessJwt });
    }
  }

  const chat = (method, options = {}) => call(method, { ...options, proxy: true });

  return {
    /**
     * @description Set the account (a new identifier or server forgets the
     * session; a refused password may be tried again).
     * @param {{ identifier: string, appPassword: string, service: string }} next - The account.
     */
    configure(next) {
      const changed =
        !credentials ||
        fingerprintOf(credentials) !== fingerprintOf(next) ||
        credentials.appPassword !== next.appPassword;
      if (credentials && fingerprintOf(credentials) !== fingerprintOf(next)) {
        session = null;
      }
      credentials = { ...next, service: next.service ?? DEFAULT_SERVICE };
      if (changed) {
        loginRefused = null;
      }
    },
    /** @description Forget the account (not configured). */
    reset() {
      credentials = null;
      session = null;
      loginRefused = null;
    },
    /**
     * @description Check the session now (createSession only when needed).
     * @param {boolean} [retryRefused] - Try a refused password again (button).
     * @returns {Promise<object>} The session (did, handle, pdsUrl…).
     */
    async connect(retryRefused = false) {
      if (retryRefused) {
        loginRefused = null;
      }
      return ready();
    },
    session: () =>
      session ? { did: session.did, handle: session.handle, pdsUrl: session.pdsUrl } : null,
    pausedUntil: () => Math.max(pauses.api, pauses.chat, pauses.session),
    call,

    // --- identity and profiles -------------------------------------------------
    resolveHandle: async (handle) =>
      (await call('com.atproto.identity.resolveHandle', { params: { handle } })).did,
    getProfile: (actor) => call('app.bsky.actor.getProfile', { params: { actor } }),
    getPosts: async (uris) =>
      (await call('app.bsky.feed.getPosts', { params: { uris } })).posts ?? [],

    // --- records ---------------------------------------------------------------------
    createRecord: async (collection, record) => {
      const current = await ready();
      return call('com.atproto.repo.createRecord', {
        http: 'POST',
        body: { repo: current.did, collection, record },
      });
    },
    deleteRecord: async (collection, rkey) => {
      const current = await ready();
      return call('com.atproto.repo.deleteRecord', {
        http: 'POST',
        body: { repo: current.did, collection, rkey },
      });
    },
    uploadBlob: async (bytes, contentType) =>
      (await call('com.atproto.repo.uploadBlob', { http: 'POST', bytes, contentType })).blob,

    // --- notifications -----------------------------------------------------------
    listNotifications: (limit = 30) =>
      call('app.bsky.notification.listNotifications', { params: { limit } }),
    getUnreadCount: async () => (await call('app.bsky.notification.getUnreadCount')).count ?? 0,

    // --- direct messages (chat.bsky, through the PDS proxy) ----------------------------
    getLog: (cursor) => chat('chat.bsky.convo.getLog', { params: { cursor } }),
    getConvo: async (convoId) =>
      (await chat('chat.bsky.convo.getConvo', { params: { convoId } })).convo,
    getConvoForMembers: async (members) =>
      (await chat('chat.bsky.convo.getConvoForMembers', { params: { members } })).convo,
    acceptConvo: (convoId) =>
      chat('chat.bsky.convo.acceptConvo', { http: 'POST', body: { convoId } }),
    sendMessage: (convoId, message) =>
      chat('chat.bsky.convo.sendMessage', { http: 'POST', body: { convoId, message } }),
    updateRead: (convoId, messageId) =>
      chat('chat.bsky.convo.updateRead', {
        http: 'POST',
        body: { convoId, ...(messageId ? { messageId } : {}) },
      }),
  };
}

export { createBlueskyApi, XrpcError, CHAT_PROXY, jwtExpiry, pdsOf, allowedOrigin };
