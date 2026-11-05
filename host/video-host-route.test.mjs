import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideoHostAsset } from './video-host-route.mjs';

test('video-host root redirects and default asset is host.html', () => {
  assert.deepEqual(resolveVideoHostAsset('/video-host'), { redirect: '/video-host/' });
  assert.deepEqual(resolveVideoHostAsset('/video-host/'), { asset: 'host.html' });
});

test('video-host serves the wrapper and its relative assets from the video subtree', () => {
  assert.deepEqual(resolveVideoHostAsset('/video-host/host.html'), { asset: 'host.html' });
  assert.deepEqual(resolveVideoHostAsset('/video-host/host.js'), { asset: 'host.js' });
  assert.deepEqual(resolveVideoHostAsset('/video-host/video-bridge.mjs'), { asset: 'video-bridge.mjs' });
});

test('video-host rejects traversal, absolute paths, map files and test sources', () => {
  assert.equal(resolveVideoHostAsset('/video-host/../host/relay.mjs').asset, undefined);
  for (const path of ['/video-host/%2e%2e/relay.mjs', '/video-host//etc/passwd', '/video-host/host.js.map', '/video-host/tests/video-bridge.test.mjs', '/video-host/%E0%A4%A', '/video-host/host.html/']) {
    assert.deepEqual(resolveVideoHostAsset(path), { status: 404 }, path);
  }
});

test('paths outside the video-host prefix are not claimed', () => {
  assert.equal(resolveVideoHostAsset('/video/'), null);
  assert.equal(resolveVideoHostAsset('/video-hostile/'), null);
  assert.equal(resolveVideoHostAsset('/editor/'), null);
  assert.equal(resolveVideoHostAsset('/'), null);
});
