import webPush from 'web-push';
import { getConnection } from '../modules/database/connection.js';

let cachedKeys = null;
const db = getConnection();

function ensureVapidKeys() {
  if (cachedKeys) return cachedKeys;

  const row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get();
  if (row) {
    cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey() {
  return ensureVapidKeys().publicKey;
}

// The VAPID "subject" (JWT `sub` claim) must be a valid `mailto:` or `https:`
// URI. Apple's push service (web.push.apple.com) rejects anything else with
// 403 BadJwtToken — notably the old `mailto:...@claudecodeui.local` default,
// whose `.local` domain silently killed all banners on Safari/iOS. Override
// via VAPID_SUBJECT (e.g. `mailto:you@example.com`); otherwise fall back to a
// valid https URL that every push service accepts.
const DEFAULT_VAPID_SUBJECT = 'https://github.com/danish-circuit/jarvis';

function resolveVapidSubject() {
  const configured = (process.env.VAPID_SUBJECT || '').trim();
  if (/^mailto:.+@.+/.test(configured) || /^https:\/\/.+/.test(configured)) {
    return configured;
  }
  if (configured) {
    console.warn(
      `Ignoring invalid VAPID_SUBJECT "${configured}" (must be mailto: or https:); using default.`
    );
  }
  return DEFAULT_VAPID_SUBJECT;
}

function configureWebPush() {
  const keys = ensureVapidKeys();
  const subject = resolveVapidSubject();
  webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  console.log(`Web Push notifications configured (subject: ${subject})`);
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
