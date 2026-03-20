// content.js - Injected into AWS Console and AWS SSO Portal pages

const IS_CONSOLE = window.location.hostname.includes('.console.aws.amazon.com') ||
                   window.location.hostname === 'console.aws.amazon.com';
const IS_SSO_PORTAL = window.location.hostname.includes('.awsapps.com');
const IS_SIGNIN = window.location.hostname === 'signin.aws.amazon.com';

// ============================================================
// Detect current role/account from the AWS Console page
// ============================================================

function detectCurrentSession() {
  // The AWS console exposes account info in the nav bar
  // We look for the account menu in the header
  const accountMenu = document.querySelector('#menu--account') ||
                      document.querySelector('[data-testid="account-menu-button"]') ||
                      document.querySelector('.globalNav-account');

  if (!accountMenu) return null;

  const text = accountMenu.textContent || '';
  const accountMatch = text.match(/(\d{12})/);
  const accountId = accountMatch ? accountMatch[1] : null;

  // Try to get role name from page title or specific elements
  const roleEl = document.querySelector('[data-testid="switch-role-display-name"]') ||
                 document.querySelector('.globalNav-user-name');
  const roleName = roleEl?.textContent?.trim() || null;

  return { accountId, roleName };
}

// ============================================================
// AWS Console Injection — adds a floating profile switcher panel
// ============================================================

let panelOpen = false;

function createConsolePanel(profiles, tree) {
  // Remove any existing panel
  document.getElementById('aws-rs-panel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'aws-rs-panel';
  panel.style.cssText = `
    position: fixed;
    top: 40px;
    right: 0;
    width: 300px;
    max-height: calc(100vh - 60px);
    background: #16213e;
    border: 1px solid #1e3a5f;
    border-right: none;
    border-radius: 8px 0 0 8px;
    box-shadow: -4px 4px 20px rgba(0,0,0,0.5);
    z-index: 9999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    color: #d0d0e0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: transform 0.2s ease;
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: #0f1829;
    border-bottom: 1px solid #1e3a5f;
    flex-shrink: 0;
  `;
  header.innerHTML = `
    <span style="color:#FF9900;font-weight:700;font-size:13px;">⬡ Role Switcher</span>
    <button id="aws-rs-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:2px 6px;">✕</button>
  `;
  panel.appendChild(header);

  // Profile list
  const list = document.createElement('div');
  list.style.cssText = 'overflow-y: auto; flex: 1; padding: 6px 0;';
  list.id = 'aws-rs-list';

  if (!tree || tree.length === 0) {
    list.innerHTML = '<div style="padding:16px;color:#555;text-align:center;">No profiles configured.<br><a href="#" id="aws-rs-settings" style="color:#7fb3e8;">Open Settings</a></div>';
  } else {
    renderTreeToPanel(list, tree, profiles, 0);
  }

  panel.appendChild(list);

  document.body.appendChild(panel);

  // Event listeners
  document.getElementById('aws-rs-close').addEventListener('click', togglePanel);
  document.getElementById('aws-rs-settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });
}

function renderTreeToPanel(container, tree, profiles, depth) {
  tree.forEach(node => {
    const profile = node.profile;
    const row = document.createElement('div');

    const isSSO = !!profile.sso_start_url;
    const indent = depth * 14;

    row.style.cssText = `
      display: flex;
      align-items: center;
      padding: 7px 12px 7px ${12 + indent + (depth > 0 ? 10 : 0)}px;
      cursor: ${(profile.role_arn || profile.sso_start_url) ? 'pointer' : 'default'};
      border-left: 3px solid transparent;
      transition: background 0.1s;
    `;

    if (depth === 0) {
      row.style.borderLeftColor = '#FF9900';
      row.style.background = '#0f1829';
    }

    row.addEventListener('mouseenter', () => {
      if (depth > 0) row.style.background = '#1e2d50';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = depth === 0 ? '#0f1829' : '';
    });

    const left = document.createElement('div');
    left.style.cssText = 'flex:1;min-width:0;';

    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameEl.textContent = (depth > 0 ? '↳ ' : '') + node.name;

    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'font-size:11px;color:#888;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;';
    if (profile.sso_start_url) {
      metaEl.textContent = `${profile.sso_account_id} · ${profile.sso_role_name}`;
    } else if (profile.role_arn) {
      const parts = profile.role_arn.split(':');
      metaEl.textContent = `${parts[4]} · ${parts[5]?.replace('role/', '')}`;
    }

    left.appendChild(nameEl);
    left.appendChild(metaEl);
    row.appendChild(left);

    if (profile.role_arn || profile.sso_start_url) {
      const btn = document.createElement('button');
      btn.textContent = 'Switch';
      btn.style.cssText = `
        background: none;
        border: 1px solid #2c4a7a;
        color: #7fb3e8;
        border-radius: 4px;
        padding: 3px 8px;
        font-size: 11px;
        cursor: pointer;
        flex-shrink: 0;
        margin-left: 6px;
        transition: background 0.1s;
      `;
      btn.addEventListener('mouseenter', () => { btn.style.background = '#1a4080'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        switchToProfile(node.name, btn);
      });
      row.addEventListener('click', () => btn.click());
      row.appendChild(btn);
    }

    container.appendChild(row);

    // Recursively render children
    if (node.children?.length > 0) {
      renderTreeToPanel(container, node.children, profiles, depth + 1);
    }
  });
}

async function switchToProfile(profileName, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '...';
  }

  const result = await chrome.runtime.sendMessage({ type: 'SWITCH_PROFILE', profileName });

  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Switch';
  }

  if (result.error) {
    showToast('Error: ' + result.error, 'error');
  } else if (result.pending) {
    showToast('SSO login required — check the new tab.', 'info');
  }
  // On success, a new tab is opened by the background script
}

function showToast(message, type = 'info') {
  const existing = document.getElementById('aws-rs-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'aws-rs-toast';
  const bgColor = type === 'error' ? '#4a1010' : '#0f3460';
  const borderColor = type === 'error' ? '#7b1e1e' : '#1a5276';
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: ${bgColor};
    border: 1px solid ${borderColor};
    color: ${type === 'error' ? '#ff6b6b' : '#7fb3e8'};
    padding: 10px 16px;
    border-radius: 6px;
    font-family: -apple-system, sans-serif;
    font-size: 13px;
    z-index: 99999;
    max-width: 320px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// Floating toggle button (always visible in the console)
function createToggleButton() {
  const existing = document.getElementById('aws-rs-toggle');
  if (existing) return;

  const btn = document.createElement('button');
  btn.id = 'aws-rs-toggle';
  btn.innerHTML = '⬡';
  btn.title = 'AWS Role Switcher';
  btn.style.cssText = `
    position: fixed;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    background: #FF9900;
    color: #000;
    border: none;
    border-radius: 6px 0 0 6px;
    padding: 10px 8px;
    font-size: 18px;
    cursor: pointer;
    z-index: 9998;
    box-shadow: -2px 0 8px rgba(0,0,0,0.3);
    line-height: 1;
    transition: background 0.15s;
    writing-mode: vertical-lr;
    letter-spacing: 0;
  `;
  btn.addEventListener('mouseenter', () => { btn.style.background = '#e88900'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#FF9900'; });
  btn.addEventListener('click', togglePanel);
  document.body.appendChild(btn);
}

async function togglePanel() {
  panelOpen = !panelOpen;

  if (!panelOpen) {
    document.getElementById('aws-rs-panel')?.remove();
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: 'GET_PROFILES' });
  if (result.error) {
    showToast('Could not load profiles: ' + result.error, 'error');
    panelOpen = false;
    return;
  }

  createConsolePanel(result.profiles, result.tree);
}

// ============================================================
// AWS SSO Portal Injection (*.awsapps.com/start)
// ============================================================

async function injectSSOPortal() {
  // Wait for the SSO portal to load
  await waitForElement('[data-testid="account-list"]', '[class*="awsui_portal"]', '#portal-application');

  const result = await chrome.runtime.sendMessage({ type: 'GET_PROFILES' });
  if (result.error || !result.tree?.length) return;

  // Find the AWS SSO portal header or create an injection point
  const container = document.querySelector('#portal-application') ||
                    document.querySelector('[data-testid="account-list"]')?.closest('[class*="container"]')?.parentElement ||
                    document.body;

  const panel = document.createElement('div');
  panel.id = 'aws-rs-sso-panel';
  panel.style.cssText = `
    background: #16213e;
    border: 1px solid #1e3a5f;
    border-radius: 8px;
    margin: 16px;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #d0d0e0;
  `;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
      <span style="color:#FF9900;font-size:18px;">⬡</span>
      <strong style="color:#fff;font-size:14px;">AWS Role Switcher — Quick Access</strong>
    </div>
    <div id="aws-rs-sso-list"></div>
  `;

  const listEl = panel.querySelector('#aws-rs-sso-list');
  renderTreeToPanel(listEl, result.tree, result.profiles, 0);

  // Insert before the first element inside container
  container.insertBefore(panel, container.firstChild);
}

function waitForElement(...selectors) {
  return new Promise(resolve => {
    const check = () => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return resolve(el);
      }
    };
    check();
    const obs = new MutationObserver(() => { check() && obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(resolve, 5000); // give up after 5s
  });
}

// ============================================================
// Multi-session: notify background of current tab's session
// ============================================================

function reportCurrentSession() {
  // Try to extract account ID from the page
  // The AWS console exposes this in various places depending on version
  const selectors = [
    '[data-testid="account-menu-button"]',
    '#menu--account',
    '.globalNav-account',
    '[class*="account-number"]',
  ];

  let accountId = null;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const match = el.textContent.match(/(\d{4}-\d{4}-\d{4}|\d{12})/);
      if (match) {
        accountId = match[1].replace(/-/g, '');
        break;
      }
    }
  }

  if (accountId) {
    chrome.runtime.sendMessage({
      type: 'SESSION_DETECTED',
      accountId,
      url: window.location.href,
    });
  }
}

// ============================================================
// Init
// ============================================================

function init() {
  if (IS_CONSOLE) {
    // Wait for page to be interactive
    const tryInject = () => {
      if (document.querySelector('#awsconsole-navigation-root') ||
          document.querySelector('.globalNav') ||
          document.querySelector('#nav-menubar') ||
          document.readyState === 'complete') {
        createToggleButton();
        reportCurrentSession();
      } else {
        setTimeout(tryInject, 500);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryInject);
    } else {
      tryInject();
    }
  }

  if (IS_SSO_PORTAL) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectSSOPortal);
    } else {
      injectSSOPortal();
    }
  }
}

init();
