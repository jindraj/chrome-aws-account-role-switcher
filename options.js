// options.js

async function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function formatExpiry(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = date - now;
  const diffMins = Math.round(diffMs / 60000);

  if (diffMs < 0) return { text: 'Expired', cls: '' };
  if (diffMins < 60) return { text: `Expires in ${diffMins}m`, cls: 'expiring' };

  const diffHours = Math.floor(diffMins / 60);
  const remMins = diffMins % 60;
  return { text: `Expires in ${diffHours}h ${remMins}m`, cls: 'valid' };
}

async function renderSSOTokens() {
  const list = document.getElementById('sso-tokens-list');
  const { ssoTokens = {} } = await chrome.storage.local.get('ssoTokens');

  if (Object.keys(ssoTokens).length === 0) {
    list.innerHTML = '<div class="no-tokens">No cached SSO tokens.</div>';
    return;
  }

  list.innerHTML = '';
  for (const [url, entry] of Object.entries(ssoTokens)) {
    const row = document.createElement('div');
    row.className = 'sso-token-row';

    const info = document.createElement('div');
    info.className = 'sso-token-info';

    const urlEl = document.createElement('div');
    urlEl.className = 'sso-token-url';
    urlEl.textContent = url;
    urlEl.title = url;

    const expiry = formatExpiry(entry.expiresAt);
    const expiryEl = document.createElement('div');
    expiryEl.className = `sso-token-expiry ${expiry.cls}`;
    expiryEl.textContent = expiry.text;

    info.appendChild(urlEl);
    info.appendChild(expiryEl);

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn-revoke';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', async () => {
      await sendMessage({ type: 'CLEAR_SSO_TOKEN', ssoStartUrl: url });
      renderSSOTokens();
    });

    row.appendChild(info);
    row.appendChild(revokeBtn);
    list.appendChild(row);
  }
}

function showSaveStatus(msg, isError = false) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = 'save-status' + (isError ? ' error' : '');
  setTimeout(() => { el.textContent = ''; }, 3000);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Load current config
  const { config } = await sendMessage({ type: 'GET_CONFIG' });
  document.getElementById('config-textarea').value = config || '';

  // Render SSO tokens
  await renderSSOTokens();

  // Save config
  document.getElementById('btn-save').addEventListener('click', async () => {
    const configText = document.getElementById('config-textarea').value;
    const result = await sendMessage({ type: 'SAVE_CONFIG', config: configText });
    if (result.error) {
      showSaveStatus(`Error: ${result.error}`, true);
    } else {
      showSaveStatus('Saved!');
    }
  });

  // Clear all SSO tokens
  document.getElementById('btn-clear-all-sso').addEventListener('click', async () => {
    if (confirm('Clear all cached SSO tokens? You will need to re-authenticate via SSO on next use.')) {
      await sendMessage({ type: 'CLEAR_ALL_SSO_TOKENS' });
      renderSSOTokens();
    }
  });

  // Ctrl+S / Cmd+S to save
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('btn-save').click();
    }
  });
});
