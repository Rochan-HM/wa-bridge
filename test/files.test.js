'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { clearDirContents } = require('../bridge');

test('clearDirContents removes children and keeps the directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-auth-'));
  await fs.writeFile(path.join(dir, 'creds.json'), '{}');
  await fs.mkdir(path.join(dir, 'nested'));
  await fs.writeFile(path.join(dir, 'nested', 'key.json'), '{}');
  await clearDirContents(dir);
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, []);
  const stat = await fs.stat(dir);
  assert.equal(stat.isDirectory(), true);
});
