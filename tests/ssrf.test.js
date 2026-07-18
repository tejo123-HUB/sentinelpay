// Security fix (post-merge audit / SSRF): unit coverage for server/utils/ssrf.js's host-blocking
// logic in isolation from the push-subscription route, so each IP-range boundary is verified
// directly rather than only indirectly through an HTTP round-trip.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isDisallowedPushEndpointHost } = require('../server/utils/ssrf');

test('isDisallowedPushEndpointHost: blocks loopback, link-local, and RFC 1918 private IPv4 ranges', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.169.254', // cloud metadata service
    '169.254.0.1',
    '100.64.0.1', // CGNAT
    '0.0.0.0',
  ];
  for (const ip of blocked) {
    assert.equal(isDisallowedPushEndpointHost(ip), true, `expected ${ip} to be blocked`);
  }
});

test('isDisallowedPushEndpointHost: does not block ordinary public IPv4 addresses', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '169.253.0.1'];
  for (const ip of allowed) {
    assert.equal(isDisallowedPushEndpointHost(ip), false, `expected ${ip} to be allowed`);
  }
});

test('isDisallowedPushEndpointHost: blocks IPv6 loopback, link-local, and unique-local ranges', () => {
  const blocked = ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'];
  for (const ip of blocked) {
    assert.equal(isDisallowedPushEndpointHost(ip), true, `expected ${ip} to be blocked`);
  }
});

test('isDisallowedPushEndpointHost: does not block a public IPv6 address', () => {
  assert.equal(isDisallowedPushEndpointHost('2606:4700:4700::1111'), false);
});

test('isDisallowedPushEndpointHost: blocks the "localhost" hostname case-insensitively', () => {
  assert.equal(isDisallowedPushEndpointHost('localhost'), true);
  assert.equal(isDisallowedPushEndpointHost('LOCALHOST'), true);
});

test('isDisallowedPushEndpointHost: allows an ordinary DNS hostname (not a literal IP)', () => {
  assert.equal(isDisallowedPushEndpointHost('push.example.com'), false);
  assert.equal(isDisallowedPushEndpointHost('fcm.googleapis.com'), false);
});
