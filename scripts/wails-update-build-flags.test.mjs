import assert from 'node:assert/strict';
import test from 'node:test';
import { updateBuildFlags } from './wails-update-build-flags.mjs';

const valid = {
  BETTERCOMMS_BUILD_UPDATE_FEED: 'https://updates.example.test/stable.json',
  BETTERCOMMS_BUILD_UPDATE_PUBLIC_KEY: Buffer.alloc(32, 7).toString('base64'),
  BETTERCOMMS_BUILD_UPDATE_DOWNLOAD_HOSTS: 'cdn.example.test',
  BETTERCOMMS_BUILD_UPDATE_MAC_TEAM_ID: 'ABCD123456',
};
test('unconfigured builds stay disabled and configured builds pin public values', () => {
  assert.equal(updateBuildFlags({}), '');
  const flags = updateBuildFlags(valid);
  assert.ok(flags.includes('-X main.bakedUpdateFeed=https://updates.example.test/stable.json'));
  assert.ok(flags.includes('-X main.bakedUpdateMacTeamID=ABCD123456'));
  assert.ok(!flags.includes('PRIVATE'));
});
test('malformed or injectable public release settings fail before invoking Go', () => {
  for (const [name, value] of [
    ['BETTERCOMMS_BUILD_UPDATE_FEED', 'http://updates.example.test/feed'],
    ['BETTERCOMMS_BUILD_UPDATE_FEED', 'https://user:pass@updates.example.test/feed'],
    ['BETTERCOMMS_BUILD_UPDATE_FEED', 'https://updates.example.test:8443/feed'],
    ['BETTERCOMMS_BUILD_UPDATE_FEED', 'https://updates.example.test/feed -X main.other=x'],
    ['BETTERCOMMS_BUILD_UPDATE_PUBLIC_KEY', Buffer.alloc(31).toString('base64')],
    ['BETTERCOMMS_BUILD_UPDATE_DOWNLOAD_HOSTS', 'cdn.example.test/path'],
    ['BETTERCOMMS_BUILD_UPDATE_DOWNLOAD_HOSTS', 'cdn.example.test, evil.example.test'],
    ['BETTERCOMMS_BUILD_UPDATE_MAC_TEAM_ID', 'unsigned'],
  ]) assert.throws(() => updateBuildFlags({ ...valid, [name]: value }), name);
  assert.throws(() => updateBuildFlags({ BETTERCOMMS_BUILD_UPDATE_FEED: valid.BETTERCOMMS_BUILD_UPDATE_FEED }));
});
