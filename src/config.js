// -----------------------------------------------------------------------------
// Configuration of the Bluesky integration (the `config_schema` of the
// manifest, filled once by an administrator of Gladys):
//
//   identifier             the handle (name.bsky.social) or the e-mail
//                          address of the Bluesky account Gladys uses
//   app_password           an app password of that account (Settings →
//                          Privacy and security → App passwords), with
//                          "Allow access to your direct messages" for DMs
//   service                the server that opens the session (advanced):
//                          https://bsky.social, or a self-hosted PDS
//   receive_messages       read the direct messages of the account
//   forward_messages       direct messages of linked users go to the brain
//   watch_notifications    read the notifications (mentions, followers…)
//   check_interval         seconds between two reads of the direct messages
//   language               the texts the integration writes itself
//
// The app password is a `secret` field: never logged, never part of an error,
// never written to /data (only the session tokens it opens are, see
// src/session-store.js).
// -----------------------------------------------------------------------------

const LANGUAGES = ['en', 'fr', 'de', 'es'];
const AUTO_LANGUAGE = 'auto';
const DEFAULT_SERVICE = 'https://bsky.social';
// Seconds between two reads of the direct messages (getLog). The official
// app polls every 60 s in the background and every 4 s in an open
// conversation: 10 to 60 s stays well within the 3,000 requests per 5 minutes
// of a PDS.
const CHECK_INTERVALS = [10, 15, 30, 60];
const DEFAULT_CHECK_INTERVAL = 15;

// The language of the last widget request, remembered for `auto`. A key the
// manifest does not declare: Gladys keeps it, the form never shows it.
const INTERNAL_KEYS = { language: 'last_dashboard_language' };

// A handle is a domain name (atproto spec, "Handle"); a DID is did:plc:… or
// did:web:….
const HANDLE =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%:-]{3,253})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @description A trimmed string, '' for anything else.
 * @param {any} value - The raw value.
 * @returns {string} The string.
 */
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @description A boolean of the configuration (Gladys may store "true").
 * @param {any} value - The raw value.
 * @param {boolean} fallback - The default when unset.
 * @returns {boolean} The value.
 */
function flag(value, fallback) {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return fallback;
}

/**
 * @description A handle typed by a user: `@name.bsky.social`, a profile link
 * (https://bsky.app/profile/name.bsky.social) or the bare handle, lower case.
 * @param {any} value - The raw value.
 * @returns {string|null} The handle or DID, null when it is neither.
 * @example
 * readActor('@Alice.bsky.social'); // -> 'alice.bsky.social'
 */
function readActor(value) {
  let raw = text(value);
  const link = /^https:\/\/bsky\.app\/profile\/([^/?#]+)/.exec(raw);
  if (link) {
    raw = decodeURIComponent(link[1]);
  }
  raw = raw.replace(/^@/, '');
  if (DID.test(raw)) {
    return raw;
  }
  return HANDLE.test(raw) ? raw.toLowerCase() : null;
}

/**
 * @description The server URL: https only (http for a local test server),
 * without a trailing slash nor a path.
 * @param {any} value - The raw value.
 * @returns {string|null} The origin, null when invalid.
 */
function readService(value) {
  const raw = text(value) || DEFAULT_SERVICE;
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    return null;
  }
  return url.origin;
}

/**
 * @description Normalize the integration configuration.
 * @param {object} [raw] - The raw values (gladys.config).
 * @returns {object} The configuration used by the integration.
 * @example
 * normalizeConfig({ identifier: 'home.bsky.social', app_password: '…' });
 */
function normalizeConfig(raw = {}) {
  const language = text(raw.language);
  const interval = Number(raw.check_interval);
  const identifier = text(raw.identifier).replace(/^@/, '');
  return {
    identifier: EMAIL.test(identifier) ? identifier : identifier.toLowerCase(),
    appPassword: text(raw.app_password),
    service: readService(raw.service),
    serviceRaw: text(raw.service),
    receiveMessages: flag(raw.receive_messages, true),
    forwardMessages: flag(raw.forward_messages, true),
    watchNotifications: flag(raw.watch_notifications, true),
    checkIntervalMs:
      (CHECK_INTERVALS.includes(interval) ? interval : DEFAULT_CHECK_INTERVAL) * 1000,
    language: LANGUAGES.includes(language) ? language : AUTO_LANGUAGE,
  };
}

/**
 * @description What is wrong with the account settings, if anything.
 * @param {object} config - normalizeConfig.
 * @returns {string|null} 'missing', 'identifier', 'service' or null.
 */
function configProblem(config) {
  if (!config.identifier || !config.appPassword) {
    return 'missing';
  }
  if (
    !EMAIL.test(config.identifier) &&
    !HANDLE.test(config.identifier) &&
    !DID.test(config.identifier)
  ) {
    return 'identifier';
  }
  if (!config.service) {
    return 'service';
  }
  return null;
}

/**
 * @description The remembered dashboard language, when valid.
 * @param {object} raw - The raw config.
 * @param {string} fallback - The default.
 * @returns {string} A language.
 */
function readLanguage(raw, fallback) {
  const value = text(raw?.[INTERNAL_KEYS.language]);
  return LANGUAGES.includes(value) ? value : fallback;
}

export {
  LANGUAGES,
  AUTO_LANGUAGE,
  DEFAULT_SERVICE,
  CHECK_INTERVALS,
  INTERNAL_KEYS,
  HANDLE,
  DID,
  normalizeConfig,
  configProblem,
  readActor,
  readService,
  readLanguage,
  flag,
};
