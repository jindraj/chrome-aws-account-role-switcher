// popup.js

async function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  document.getElementById('error-message').textContent = msg;
  banner.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

function showSSO(pendingSSO) {
  const banner = document.getElementById('sso-banner');
  if (pendingSSO) {
    document.getElementById('sso-user-code').textContent = pendingSSO.userCode || '';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// Build the profile tree DOM recursively
function buildProfileNode(node, depth = 0, openProfiles = new Set()) {
  const fragment = document.createDocumentFragment();
  const profile = node.profile;

  if (depth === 0) {
    // Root node (SSO base or standalone)
    const group = document.createElement('div');
    group.className = 'profile-group';

    const root = document.createElement('div');
    root.className = 'profile-root';

    const left = document.createElement('div');
    left.className = 'profile-root-left';

    const nameEl = document.createElement('div');
    nameEl.className = 'profile-name';
    nameEl.textContent = node.name;

    const meta = document.createElement('div');
    meta.className = 'profile-meta';
    if (profile.sso_start_url) {
      meta.textContent = `${profile.sso_account_id} · ${profile.sso_role_name}`;
    } else if (profile.role_arn) {
      meta.textContent = profile.role_arn.split(':').pop();
    }

    left.appendChild(nameEl);
    left.appendChild(meta);

    const badge = document.createElement('span');
    badge.className = 'profile-badge ' + (profile.sso_start_url ? 'badge-sso' : 'badge-role');
    badge.textContent = profile.sso_start_url ? 'SSO' : 'Role';

    root.appendChild(left);

    // Active session indicator (multi-session: this profile is open in a tab)
    if (openProfiles.has(node.name)) {
      const dot = document.createElement('span');
      dot.className = 'session-dot';
      dot.title = 'Open in a tab';
      root.appendChild(dot);
    }

    root.appendChild(badge);

    // All profiles with a role or SSO identity are directly switchable
    if (profile.sso_start_url || profile.role_arn) {
      attachSwitchButton(root, node.name, left);
    }

    group.appendChild(root);

    if (node.children.length > 0) {
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'profile-children';
      node.children.forEach(child => {
        childrenDiv.appendChild(buildProfileNode(child, 1, openProfiles));
      });
      group.appendChild(childrenDiv);
    }

    fragment.appendChild(group);
  } else {
    // Child node (chained role)
    const row = document.createElement('div');
    row.className = 'profile-child';
    row.style.paddingLeft = `${12 + depth * 16}px`;

    const left = document.createElement('div');
    left.className = 'profile-child-left';

    const nameEl = document.createElement('div');
    nameEl.className = 'profile-name';
    nameEl.textContent = node.name;

    const meta = document.createElement('div');
    meta.className = 'profile-meta';
    if (profile.role_arn) {
      const parts = profile.role_arn.split(':');
      const accountId = parts[4];
      const rolePart = parts[5]?.replace('role/', '');
      meta.textContent = `${accountId} · ${rolePart}`;
    }

    left.appendChild(nameEl);
    left.appendChild(meta);
    row.appendChild(left);

    // Multi-session indicator
    if (openProfiles.has(node.name)) {
      const dot = document.createElement('span');
      dot.className = 'session-dot';
      dot.title = 'Open in a tab';
      row.appendChild(dot);
    }

    attachSwitchButton(row, node.name, left);

    // Render grandchildren inline
    fragment.appendChild(row);
    node.children.forEach(child => {
      fragment.appendChild(buildProfileNode(child, depth + 1, openProfiles));
    });

    return fragment;
  }

  return fragment;
}

function attachSwitchButton(row, profileName, leftEl) {
  const btn = document.createElement('button');
  btn.className = 'btn-switch';
  btn.textContent = 'Switch';
  btn.dataset.profile = profileName;

  row.appendChild(btn);

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    hideError();
    btn.disabled = true;
    btn.textContent = '...';
    btn.classList.add('loading');

    const result = await sendMessage({ type: 'SWITCH_PROFILE', profileName });

    btn.disabled = false;
    btn.textContent = 'Switch';
    btn.classList.remove('loading');

    if (result.error) {
      showError(result.error);
    } else if (result.pending) {
      showSSO({ userCode: result.userCode });
    } else {
      window.close();
    }
  });

  // Also make the whole row clickable
  row.addEventListener('click', () => btn.click());
}

async function renderProfiles() {
  const loading = document.getElementById('loading');
  const noConfig = document.getElementById('no-config');
  const treeEl = document.getElementById('profile-tree');

  const [profilesResult, tabResult] = await Promise.all([
    sendMessage({ type: 'GET_PROFILES' }),
    sendMessage({ type: 'GET_TAB_SESSIONS' }),
  ]);

  if (profilesResult.error) {
    loading.classList.add('hidden');
    showError(profilesResult.error);
    return;
  }

  const { profiles, tree } = profilesResult;
  const tabSessions = tabResult?.tabSessions ?? {};

  // Build a set of profile names that have open tabs
  const openProfiles = new Set(
    Object.values(tabSessions)
      .map(s => s.profileName)
      .filter(Boolean)
  );

  loading.classList.add('hidden');

  if (!tree || tree.length === 0) {
    noConfig.classList.remove('hidden');
    return;
  }

  treeEl.classList.remove('hidden');
  treeEl.innerHTML = '';

  let first = true;
  tree.forEach(rootNode => {
    if (!first) {
      const sep = document.createElement('div');
      sep.className = 'separator';
      treeEl.appendChild(sep);
    }
    treeEl.appendChild(buildProfileNode(rootNode, 0, openProfiles));
    first = false;
  });
}

async function checkSSOStatus() {
  const { pendingSSO } = await sendMessage({ type: 'GET_SSO_STATUS' });
  showSSO(pendingSSO);
}

document.addEventListener('DOMContentLoaded', async () => {
  await renderProfiles();
  await checkSSOStatus();

  document.getElementById('btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('btn-open-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('btn-dismiss-error').addEventListener('click', hideError);

  document.getElementById('btn-cancel-sso').addEventListener('click', async () => {
    await sendMessage({ type: 'CANCEL_SSO' });
    showSSO(null);
  });
});
