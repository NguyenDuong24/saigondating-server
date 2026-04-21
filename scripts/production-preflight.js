#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isLikelyPlaceholder(v) {
  const s = String(v || '').toLowerCase();
  return !s || s.includes('your_') || s.includes('change_to_') || s.includes('xxxxx') || s.includes('example');
}

function fail(msg, failures) {
  failures.push(msg);
}

function warn(msg, warnings) {
  warnings.push(msg);
}

function main() {
  const root = path.resolve(__dirname, '..');
  const envPath = path.join(root, '.env.production');
  const fallbackPath = path.join(root, '.env');
  const failures = [];
  const warnings = [];

  const filePath = fs.existsSync(envPath) ? envPath : (fs.existsSync(fallbackPath) ? fallbackPath : null);
  if (!filePath) {
    console.error('✗ Missing .env.production (or .env) in saigondating-server');
    process.exit(1);
  }

  const env = parseEnvFile(filePath);
  console.log(`Using env file: ${path.basename(filePath)}`);

  const required = [
    'NODE_ENV',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY_ID',
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_CLIENT_ID',
    'CORS_ORIGINS',
    'WEBHOOK_SECRET',
    'CRON_SECRET',
    'VIETQR_ACCOUNT',
    'VIETQR_ACCOUNT_NAME',
    'PRO_UPGRADE_PRICE',
    'VIDEOSDK_API_KEY',
    'VIDEOSDK_SECRET_KEY',
  ];

  for (const k of required) {
    if (!(k in env) || isLikelyPlaceholder(env[k])) {
      fail(`Missing/placeholder env: ${k}`, failures);
    }
  }

  if (env.NODE_ENV !== 'production') {
    fail(`NODE_ENV must be production (current: ${env.NODE_ENV || 'unset'})`, failures);
  }

  if (String(env.REQUIRE_IDEMPOTENCY_KEY).toLowerCase() !== 'true') {
    warn('REQUIRE_IDEMPOTENCY_KEY is not true (recommended true in production)', warnings);
  }

  const price = Number(env.PRO_UPGRADE_PRICE);
  if (!Number.isFinite(price) || price <= 0) {
    fail('PRO_UPGRADE_PRICE must be a positive number', failures);
  }

  if (env.VIETQR_COIN_PACKAGES) {
    try {
      const parsed = JSON.parse(env.VIETQR_COIN_PACKAGES);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        fail('VIETQR_COIN_PACKAGES must be a non-empty JSON array', failures);
      }
    } catch (_e) {
      fail('VIETQR_COIN_PACKAGES is not valid JSON', failures);
    }
  } else {
    warn('VIETQR_COIN_PACKAGES not set, server will use defaults', warnings);
  }

  const firestoreRules = path.resolve(root, '..', 'firestore.rules');
  const storageRules = path.resolve(root, '..', 'storage.rules');
  if (!fs.existsSync(firestoreRules)) warn('Cannot find firestore.rules near project root', warnings);
  if (!fs.existsSync(storageRules)) warn('Cannot find storage.rules near project root', warnings);

  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`- ${w}`);
  }

  if (failures.length) {
    console.error('\nPreflight FAILED:');
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }

  console.log('\n✓ Production preflight passed');
}

main();
