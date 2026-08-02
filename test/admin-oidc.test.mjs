import assert from 'node:assert/strict';
import test from 'node:test';
import { loadOidcSettings } from '../build/admin-oidc.js';

const oidcKeys = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_PROVIDER_NAME', 'NODE_ENV'];

function withEnvironment(values, run) {
  const original = Object.fromEntries(oidcKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of oidcKeys) delete process.env[key];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const key of oidcKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test('uses local authentication when OIDC is not configured', () => {
  withEnvironment({}, () => assert.equal(loadOidcSettings(), undefined));
});

test('rejects incomplete OIDC configuration', () => {
  withEnvironment({ OIDC_ISSUER: 'https://auth.example.com' }, () => {
    assert.throws(() => loadOidcSettings(), /Incomplete OIDC configuration/);
  });
});

test('loads a complete OIDC configuration', () => {
  withEnvironment({
    OIDC_ISSUER: 'https://auth.example.com',
    OIDC_CLIENT_ID: 'mcp-proxy',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://mcp.example.com/admin/oidc/callback',
    NODE_ENV: 'production',
  }, () => {
    assert.deepEqual(loadOidcSettings(), {
      issuer: 'https://auth.example.com',
      clientId: 'mcp-proxy',
      clientSecret: 'secret',
      redirectUri: 'https://mcp.example.com/admin/oidc/callback',
      providerName: 'OIDC provider',
    });
  });
});

test('requires the exact OIDC callback path', () => {
  withEnvironment({
    OIDC_ISSUER: 'https://auth.example.com',
    OIDC_CLIENT_ID: 'mcp-proxy',
    OIDC_CLIENT_SECRET: 'secret',
    OIDC_REDIRECT_URI: 'https://mcp.example.com/admin/callback',
  }, () => {
    assert.throws(() => loadOidcSettings(), /OIDC_REDIRECT_URI must be an exact URL/);
  });
});
