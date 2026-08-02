import * as oidc from 'openid-client';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  providerName: string;
}

export interface OidcTransaction {
  codeVerifier: string;
  state: string;
  nonce: string;
}

export interface OidcUser {
  subject: string;
  username: string;
}

const OIDC_ENVIRONMENT_KEYS = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
] as const;

function value(name: typeof OIDC_ENVIRONMENT_KEYS[number]): string | undefined {
  const rawValue = process.env[name]?.trim();
  return rawValue ? rawValue : undefined;
}

/**
 * Returns undefined when OIDC is intentionally not configured. Supplying only
 * some OIDC values is unsafe because it could silently retain local login.
 */
export function loadOidcSettings(): OidcSettings | undefined {
  const supplied = OIDC_ENVIRONMENT_KEYS.filter((key) => value(key) !== undefined);
  if (supplied.length === 0) return undefined;
  if (supplied.length !== OIDC_ENVIRONMENT_KEYS.length) {
    const missing = OIDC_ENVIRONMENT_KEYS.filter((key) => value(key) === undefined);
    throw new Error(`Incomplete OIDC configuration. Missing: ${missing.join(', ')}`);
  }

  const issuer = value('OIDC_ISSUER')!;
  const redirectUri = value('OIDC_REDIRECT_URI')!;
  let issuerUrl: URL;
  let redirectUrl: URL;
  try {
    issuerUrl = new URL(issuer);
    redirectUrl = new URL(redirectUri);
  } catch {
    throw new Error('OIDC_ISSUER and OIDC_REDIRECT_URI must be valid absolute URLs.');
  }

  if (issuerUrl.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('OIDC_ISSUER must use HTTPS in production.');
  }
  if (redirectUrl.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('OIDC_REDIRECT_URI must use HTTPS in production.');
  }
  if (redirectUrl.pathname !== '/admin/oidc/callback' || redirectUrl.search || redirectUrl.hash) {
    throw new Error('OIDC_REDIRECT_URI must be an exact URL ending in /admin/oidc/callback.');
  }

  return {
    issuer,
    clientId: value('OIDC_CLIENT_ID')!,
    clientSecret: value('OIDC_CLIENT_SECRET')!,
    redirectUri,
    providerName: process.env.OIDC_PROVIDER_NAME?.trim() || 'OIDC provider',
  };
}

export async function discoverOidcClient(settings: OidcSettings): Promise<oidc.Configuration> {
  return oidc.discovery(
    new URL(settings.issuer),
    settings.clientId,
    undefined,
    oidc.ClientSecretPost(settings.clientSecret),
  );
}

export async function beginOidcAuthorization(
  config: oidc.Configuration,
  settings: OidcSettings,
): Promise<{ authorizationUrl: string; transaction: OidcTransaction }> {
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });

  return {
    authorizationUrl: authorizationUrl.href,
    transaction: { codeVerifier, state, nonce },
  };
}

export async function completeOidcAuthorization(
  config: oidc.Configuration,
  callbackUrl: URL,
  transaction: OidcTransaction,
): Promise<OidcUser> {
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: transaction.codeVerifier,
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.sub) {
    throw new Error('OIDC ID token did not contain a subject claim.');
  }

  const username = [claims.preferred_username, claims.email, claims.name, claims.sub]
    .find((claim): claim is string => typeof claim === 'string' && claim.trim() !== '');

  return { subject: claims.sub, username: username! };
}
