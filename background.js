// background.js - Service Worker
// Handles all AWS API calls: SSO auth, STS role chaining, Console Federation

// ============================================================
// AWS Signature V4 Implementation (using Web Crypto API)
// ============================================================

async function sha256Hex(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(hash);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(keyData, message) {
  const keyBuffer = typeof keyData === 'string' ? new TextEncoder().encode(keyData) : keyData;
  const msgBuffer = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const key = await crypto.subtle.importKey(
    'raw', keyBuffer, { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', key, msgBuffer);
}

async function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate = await hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

async function signRequest({ method, url, headers = {}, body = '', credentials, service, region }) {
  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname || '/';

  const sortedParams = Array.from(new URLSearchParams(urlObj.search).entries())
    .sort(([a], [b]) => a.localeCompare(b));
  const canonicalQueryString = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headerMap = {};
  for (const [k, v] of Object.entries(headers)) {
    headerMap[k.toLowerCase()] = v;
  }
  headerMap['host'] = host;
  headerMap['x-amz-date'] = amzDate;
  if (credentials.sessionToken) {
    headerMap['x-amz-security-token'] = credentials.sessionToken;
  }

  const sortedHeaderNames = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedHeaderNames.map(n => `${n}:${headerMap[n].trim()}\n`).join('');
  const signedHeaders = sortedHeaderNames.join(';');
  const payloadHash = await sha256Hex(body);

  const canonicalRequest = [
    method.toUpperCase(), path, canonicalQueryString, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = bufferToHex(await hmacSha256(signingKey, stringToSign));

  return {
    ...headerMap,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ============================================================
// AWS CLI Config Parser
// ============================================================

function parseAwsConfig(configText) {
  const profiles = {};
  let currentProfile = null;

  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const profileMatch = trimmed.match(/^\[(?:profile\s+)?(.+?)\]$/);
    if (profileMatch) {
      currentProfile = profileMatch[1].trim();
      profiles[currentProfile] = {};
      continue;
    }

    if (currentProfile && trimmed.includes('=')) {
      const eqIndex = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      profiles[currentProfile][key] = value;
    }
  }

  return profiles;
}

// Build a tree structure showing profile dependencies
function buildProfileTree(profiles) {
  const roots = [];
  const children = {};

  for (const [name, profile] of Object.entries(profiles)) {
    const parent = profile.source_profile;
    if (parent) {
      if (!children[parent]) children[parent] = [];
      children[parent].push(name);
    } else {
      roots.push(name);
    }
  }

  function buildNode(name) {
    return {
      name,
      profile: profiles[name],
      children: (children[name] || []).map(buildNode),
    };
  }

  return roots.map(buildNode);
}

// ============================================================
// STS API
// ============================================================

function parseSTSCredentials(xml) {
  const get = tag => xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1] ?? null;
  return {
    accessKeyId: get('AccessKeyId'),
    secretAccessKey: get('SecretAccessKey'),
    sessionToken: get('SessionToken'),
    expiration: get('Expiration'),
  };
}

async function assumeRole(credentials, roleArn, sessionName, externalId, region = 'us-east-1') {
  const endpoint = `https://sts.${region}.amazonaws.com/`;
  const params = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: sessionName || 'aws-role-switcher',
    DurationSeconds: '3600',
  });
  if (externalId) params.set('ExternalId', externalId);

  const body = params.toString();
  const headers = await signRequest({
    method: 'POST',
    url: endpoint,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    credentials,
    service: 'sts',
    region,
  });

  const response = await fetch(endpoint, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) {
    const msg = text.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? text;
    throw new Error(`AssumeRole(${roleArn}) failed: ${msg}`);
  }
  return parseSTSCredentials(text);
}

// ============================================================
// AWS SSO OIDC (Device Authorization Flow)
// ============================================================

async function ssoRegisterClient(region) {
  const url = `https://oidc.${region}.amazonaws.com/client/register`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'aws-role-switcher', clientType: 'public' }),
  });
  if (!response.ok) throw new Error(`SSO RegisterClient failed: ${await response.text()}`);
  return response.json();
}

async function ssoStartDeviceAuth(region, clientId, clientSecret, startUrl) {
  const url = `https://oidc.${region}.amazonaws.com/device_authorization`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, startUrl }),
  });
  if (!response.ok) throw new Error(`SSO StartDeviceAuthorization failed: ${await response.text()}`);
  return response.json();
}

async function ssoCreateToken(region, clientId, clientSecret, deviceCode) {
  const url = `https://oidc.${region}.amazonaws.com/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      deviceCode,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    if (data.error === 'authorization_pending' || data.error === 'slow_down') return null;
    throw new Error(`SSO token failed: ${data.error_description || data.error}`);
  }
  return data;
}

async function ssoGetRoleCredentials(region, accessToken, accountId, roleName) {
  const url = `https://portal.sso.${region}.amazonaws.com/federation/credentials?account_id=${accountId}&role_name=${encodeURIComponent(roleName)}`;
  const response = await fetch(url, { headers: { 'x-amz-sso_bearer_token': accessToken } });
  if (!response.ok) throw new Error(`SSO GetRoleCredentials failed: ${await response.text()}`);
  const { roleCredentials: c } = await response.json();
  return {
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
    expiration: new Date(c.expiration).toISOString(),
  };
}

// ============================================================
// SSO Token Cache (chrome.storage.local)
// ============================================================

async function getCachedSSOToken(ssoStartUrl) {
  const { ssoTokens = {} } = await chrome.storage.local.get('ssoTokens');
  const entry = ssoTokens[ssoStartUrl];
  if (entry && new Date(entry.expiresAt) > new Date(Date.now() + 60000)) {
    return entry.accessToken;
  }
  return null;
}

async function cacheSSOToken(ssoStartUrl, accessToken, expiresIn) {
  const { ssoTokens = {} } = await chrome.storage.local.get('ssoTokens');
  ssoTokens[ssoStartUrl] = {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
  await chrome.storage.local.set({ ssoTokens });
}

async function clearSSOToken(ssoStartUrl) {
  const { ssoTokens = {} } = await chrome.storage.local.get('ssoTokens');
  delete ssoTokens[ssoStartUrl];
  await chrome.storage.local.set({ ssoTokens });
}

// ============================================================
// SSO Device Auth Flow (opens browser tab for user to authenticate)
// ============================================================

class SSOPendingError extends Error {
  constructor(verificationUri, userCode) {
    super('SSO authentication required');
    this.name = 'SSOPendingError';
    this.verificationUri = verificationUri;
    this.userCode = userCode;
  }
}

async function startSSOAuth(ssoStartUrl, ssoRegion) {
  const client = await ssoRegisterClient(ssoRegion);
  const deviceAuth = await ssoStartDeviceAuth(ssoRegion, client.clientId, client.clientSecret, ssoStartUrl);

  await chrome.storage.local.set({
    pendingSSO: {
      ssoStartUrl,
      ssoRegion,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      deviceCode: deviceAuth.deviceCode,
      verificationUriComplete: deviceAuth.verificationUriComplete,
      userCode: deviceAuth.userCode,
      interval: Math.max(deviceAuth.interval || 5, 5),
      expiresAt: new Date(Date.now() + deviceAuth.expiresIn * 1000).toISOString(),
    },
  });

  // Open SSO login in a new tab
  await chrome.tabs.create({ url: deviceAuth.verificationUriComplete });

  throw new SSOPendingError(deviceAuth.verificationUriComplete, deviceAuth.userCode);
}

// ============================================================
// Credential Chain Resolver
// ============================================================

async function resolveCredentials(profileName, profiles, depth = 0) {
  if (depth > 10) throw new Error('Maximum role chaining depth (10) exceeded');

  const profile = profiles[profileName];
  if (!profile) throw new Error(`Profile '${profileName}' not found in config`);

  // SSO profile (base identity)
  if (profile.sso_start_url) {
    const cached = await getCachedSSOToken(profile.sso_start_url);
    if (cached) {
      return ssoGetRoleCredentials(
        profile.sso_region,
        cached,
        profile.sso_account_id,
        profile.sso_role_name
      );
    }
    // Will throw SSOPendingError and open the browser tab
    return startSSOAuth(profile.sso_start_url, profile.sso_region);
  }

  // Chained role profile
  if (profile.source_profile && profile.role_arn) {
    const sourceCredentials = await resolveCredentials(profile.source_profile, profiles, depth + 1);
    const region = profile.region || 'us-east-1';
    return assumeRole(
      sourceCredentials,
      profile.role_arn,
      profile.role_session_name || `switcher-${profileName.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      profile.external_id,
      region
    );
  }

  throw new Error(`Profile '${profileName}' has no valid auth method (needs sso_start_url or source_profile+role_arn)`);
}

// ============================================================
// AWS Console Federation
// ============================================================

async function buildConsoleUrl(credentials, destination = 'https://console.aws.amazon.com/') {
  const sessionJson = JSON.stringify({
    sessionId: credentials.accessKeyId,
    sessionKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  });

  const federationUrl = `https://signin.aws.amazon.com/federation?Action=getSigninToken&Session=${encodeURIComponent(sessionJson)}`;
  const response = await fetch(federationUrl);
  if (!response.ok) {
    throw new Error(`Federation getSigninToken failed (${response.status}): ${await response.text()}`);
  }

  const { SigninToken } = await response.json();
  return `https://signin.aws.amazon.com/federation?Action=login&Issuer=aws-role-switcher&Destination=${encodeURIComponent(destination)}&SigninToken=${SigninToken}`;
}

// ============================================================
// SSO Polling (via chrome.alarms)
// ============================================================

async function pollPendingSSO() {
  const { pendingSSO } = await chrome.storage.local.get('pendingSSO');
  if (!pendingSSO) return;

  if (new Date(pendingSSO.expiresAt) < new Date()) {
    await chrome.storage.local.remove('pendingSSO');
    return;
  }

  const tokenData = await ssoCreateToken(
    pendingSSO.ssoRegion,
    pendingSSO.clientId,
    pendingSSO.clientSecret,
    pendingSSO.deviceCode
  );

  if (tokenData) {
    await cacheSSOToken(pendingSSO.ssoStartUrl, tokenData.accessToken, tokenData.expiresIn);
    await chrome.storage.local.remove('pendingSSO');

    // Resume any queued switch action
    const { pendingSwitchProfile } = await chrome.storage.local.get('pendingSwitchProfile');
    if (pendingSwitchProfile) {
      await chrome.storage.local.remove('pendingSwitchProfile');
      await doSwitchProfile(pendingSwitchProfile);
    }

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'AWS SSO Authenticated',
      message: 'SSO login complete. Your role switch is being processed.',
    });
  }
}

chrome.alarms.create('ssoPoller', { periodInMinutes: 0.1 }); // poll every ~6s
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'ssoPoller') pollPendingSSO().catch(console.error);
});

// ============================================================
// Switch Profile Action
// ============================================================

async function doSwitchProfile(profileName) {
  const { awsConfig = '' } = await chrome.storage.sync.get('awsConfig');
  const profiles = parseAwsConfig(awsConfig);
  const credentials = await resolveCredentials(profileName, profiles);
  const consoleUrl = await buildConsoleUrl(credentials);
  const tab = await chrome.tabs.create({ url: consoleUrl });
  await recordTabSwitch(tab.id, profileName);
}

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message, errorType: err.name }));
  return true; // keep channel open for async
});

async function handleMessage(message) {
  switch (message.type) {

    case 'GET_PROFILES': {
      const { awsConfig = '' } = await chrome.storage.sync.get('awsConfig');
      const profiles = parseAwsConfig(awsConfig);
      const tree = buildProfileTree(profiles);
      return { profiles, tree };
    }

    case 'SWITCH_PROFILE': {
      const { profileName } = message;
      const { awsConfig = '' } = await chrome.storage.sync.get('awsConfig');
      const profiles = parseAwsConfig(awsConfig);

      try {
        await doSwitchProfile(profileName);
        return { success: true };
      } catch (err) {
        if (err.name === 'SSOPendingError') {
          // Queue the switch to resume after SSO
          await chrome.storage.local.set({ pendingSwitchProfile: profileName });
          return {
            pending: true,
            verificationUri: err.verificationUri,
            userCode: err.userCode,
          };
        }
        throw err;
      }
    }

    case 'GET_SSO_STATUS': {
      const { pendingSSO = null } = await chrome.storage.local.get('pendingSSO');
      return { pendingSSO };
    }

    case 'CLEAR_SSO_TOKEN': {
      await clearSSOToken(message.ssoStartUrl);
      return { success: true };
    }

    case 'CLEAR_ALL_SSO_TOKENS': {
      await chrome.storage.local.set({ ssoTokens: {} });
      return { success: true };
    }

    case 'SAVE_CONFIG': {
      await chrome.storage.sync.set({ awsConfig: message.config });
      return { success: true };
    }

    case 'GET_CONFIG': {
      const { awsConfig = '' } = await chrome.storage.sync.get('awsConfig');
      return { config: awsConfig };
    }

    case 'CANCEL_SSO': {
      await chrome.storage.local.remove(['pendingSSO', 'pendingSwitchProfile']);
      return { success: true };
    }

    case 'OPEN_OPTIONS': {
      chrome.runtime.openOptionsPage();
      return { success: true };
    }

    // Content script reports which account is active in the current console tab
    case 'SESSION_DETECTED': {
      const { tabSessions = {} } = await chrome.storage.local.get('tabSessions');
      tabSessions[message.tabId || 'unknown'] = {
        accountId: message.accountId,
        url: message.url,
        detectedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({ tabSessions });
      return { success: true };
    }

    case 'GET_TAB_SESSIONS': {
      const { tabSessions = {} } = await chrome.storage.local.get('tabSessions');
      return { tabSessions };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

// Clean up tab sessions when tabs are closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabSessions = {} } = await chrome.storage.local.get('tabSessions');
  delete tabSessions[tabId];
  await chrome.storage.local.set({ tabSessions });
});

// Track which tab a profile was switched into
async function recordTabSwitch(tabId, profileName) {
  const { tabSessions = {} } = await chrome.storage.local.get('tabSessions');
  tabSessions[tabId] = { profileName, openedAt: new Date().toISOString() };
  await chrome.storage.local.set({ tabSessions });
}
