// ChannelScope v1.3.4 verification tests (temp server, no real YouTube calls).
// Run: node test/v1.3.4.test.js
// What it proves (no real key — all key values below are fake test strings):
//  1. Env key used when the settings key is empty.
//  2. Settings key wins when both are set.
//  3. No key when neither is set (incl. whitespace-only values).
//  4. /api/status and /api/diag hasKey reflect the EFFECTIVE key (either
//     source), and neither response ever contains the key value itself.
//  5. The env key is never persisted into data/settings.json (the resolver
//     is pure — quota saves must not copy it there).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..');
const ENV_KEY = 'FAKE-ENV-KEY-134';
const SETTINGS_KEY = 'FAKE-SETTINGS-KEY-134';

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

// ---------- unit: effectiveApiKey precedence ----------
const { effectiveApiKey } = require(path.join(SRC, 'server.js'));
const savedEnv = process.env.YOUTUBE_API_KEY;
function withEnv(value, fn) {
  if (value === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = value;
  try { fn(); } finally {
    if (savedEnv === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = savedEnv;
  }
}

withEnv(ENV_KEY, () => {
  check('env key used when settings key is empty',
    effectiveApiKey({ apiKey: '' }) === ENV_KEY);
  check('settings key wins when both are set',
    effectiveApiKey({ apiKey: SETTINGS_KEY }) === SETTINGS_KEY);
  check('whitespace-only settings key falls back to env key',
    effectiveApiKey({ apiKey: '   ' }) === ENV_KEY);
  check('no-arg call reads env key (settings file has no key)',
    effectiveApiKey() === ENV_KEY);
});
withEnv(undefined, () => {
  check('no key when neither is set',
    effectiveApiKey({ apiKey: '' }) === '');
  check('no key when settings key is empty and env is unset',
    effectiveApiKey() === '');
});
withEnv('   ', () => {
  check('whitespace-only env key counts as no key',
    effectiveApiKey({ apiKey: '' }) === '');
});

// ---------- HTTP: hasKey reflects the effective key ----------
function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs134-'));
  fs.cpSync(SRC, dir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== '.git' && base !== 'node_modules' && base !== 'data' && base !== 'test' && base !== 'deploy-v1.3.4';
    }
  });
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  const { app } = require(path.join(dir, 'server.js'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ dir, server, port: server.address().port }));
  });
}

async function main() {
  const S = await makeServer();
  const base = `http://127.0.0.1:${S.port}`;
  const settingsFile = path.join(S.dir, 'data', 'settings.json');
  const readSettings = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { return null; }
  };
  async function getStatus() {
    const r = await fetch(base + '/api/status');
    return r.json();
  }
  async function getDiag() {
    const r = await fetch(base + '/api/diag');
    return r.json();
  }

  // A. Neither source: hasKey false on both endpoints.
  delete process.env.YOUTUBE_API_KEY;
  let st = await getStatus();
  check('[HTTP] no key anywhere -> status hasKey false', st.hasKey === false, 'hasKey=' + st.hasKey);
  let dg = await getDiag();
  check('[HTTP] no key anywhere -> diag hasKey false', dg.hasKey === false, 'hasKey=' + dg.hasKey);

  // B. Env key only: hasKey true, key value never leaked in the response.
  process.env.YOUTUBE_API_KEY = ENV_KEY;
  st = await getStatus();
  check('[HTTP] env key only -> status hasKey true', st.hasKey === true, 'hasKey=' + st.hasKey);
  check('[HTTP] status response never contains the env key value',
    !JSON.stringify(st).includes(ENV_KEY));
  dg = await getDiag();
  check('[HTTP] env key only -> diag hasKey true', dg.hasKey === true, 'hasKey=' + dg.hasKey);
  check('[HTTP] diag response never contains the env key value',
    !JSON.stringify(dg).includes(ENV_KEY));

  // C. Env key must NOT be persisted into settings.json by any status call.
  const afterEnv = readSettings();
  check('[HTTP] env key never persisted to settings.json',
    afterEnv === null || !afterEnv.apiKey, JSON.stringify(afterEnv));

  // D. Settings key set (env still set): hasKey true; settings key wins
  //    (unit test proves the value; here the stored file must be untouched).
  fs.mkdirSync(path.join(S.dir, 'data'), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ apiKey: SETTINGS_KEY, quotaUsed: 0, quotaDate: '' }));
  st = await getStatus();
  check('[HTTP] settings key + env key -> status hasKey true', st.hasKey === true, 'hasKey=' + st.hasKey);
  check('[HTTP] status response never contains the settings key value',
    !JSON.stringify(st).includes(SETTINGS_KEY));
  check('[HTTP] settings file still holds the settings key (env did not overwrite it)',
    readSettings() && readSettings().apiKey === SETTINGS_KEY);

  // E. Settings key cleared + env removed: hasKey false again.
  fs.writeFileSync(settingsFile, JSON.stringify({ apiKey: '', quotaUsed: 0, quotaDate: '' }));
  delete process.env.YOUTUBE_API_KEY;
  st = await getStatus();
  check('[HTTP] both cleared -> status hasKey false', st.hasKey === false, 'hasKey=' + st.hasKey);

  S.server.close();
  if (savedEnv === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = savedEnv;
  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST CRASH:', e); process.exit(2); });
