# AWS Role Switcher

A Chrome extension for switching AWS accounts and roles — with first-class **role chaining** support.

## Why this exists

Existing extensions like [aws-extend-switch-roles](https://github.com/tilfinltd/aws-extend-switch-roles) are great for simple single-hop role switching, but they fall short when your AWS setup involves chained roles via `source_profile` — a common pattern in organisations that use AWS SSO as the identity source and then assume roles across multiple member accounts.

With those tools you either have to switch roles manually step-by-step, or fall back to the CLI. This extension solves that: configure your profiles exactly as you would in `~/.aws/config`, click once, and land directly in the target account's console — no matter how deep the chain goes.

## Features

- **Role chaining** — follows `source_profile` recursively (SSO → role → role → role → console)
- **AWS SSO** — authenticates via the OAuth 2.0 Device Authorization flow; token is cached so subsequent switches are instant
- **Multi-session** — each switch opens a **new tab** with an independent federated console session; you can have multiple accounts open simultaneously
- **In-console panel** — a floating `⬡` button on every AWS console page opens a profile switcher without going back to the popup
- **SSO portal injection** — profile panel is also injected into the AWS SSO portal (`*.awsapps.com`)
- **Familiar config format** — paste your existing `~/.aws/config` directly into the settings page

## Installation

1. Clone or download this repository
2. Run `node create-icons.js` to generate the extension icons
3. Open `chrome://extensions/`
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked** and select this directory

## Configuration

Open the extension settings (⚙ in the popup) and paste your `~/.aws/config` content. The full AWS CLI config format is supported.

### SSO base profile + chained roles

```ini
[profile my-org-sso]
sso_account_id = 123456789012
sso_role_name  = AdministratorAccess
sso_region     = eu-west-1
sso_start_url  = https://myorg.awsapps.com/start

[profile dev]
region          = eu-west-1
role_arn        = arn:aws:iam::111111111111:role/developer
source_profile  = my-org-sso

[profile staging]
region          = eu-west-1
role_arn        = arn:aws:iam::222222222222:role/staging-admin
source_profile  = my-org-sso

[profile production]
region          = eu-west-1
role_arn        = arn:aws:iam::333333333333:role/production-admin
source_profile  = my-org-sso
```

### Multi-hop chaining (SSO → intermediate → leaf)

```ini
[profile org-sso]
sso_account_id = 100000000001
sso_role_name  = AdministratorAccess
sso_region     = eu-west-1
sso_start_url  = https://myorg.awsapps.com/start

[profile platform]
region             = eu-west-1
role_arn           = arn:aws:iam::200000000002:role/platform-role
role_session_name  = jane.doe@example.com
source_profile     = org-sso
external_id        = my-external-id

[profile platform-ops]
region          = eu-west-1
role_arn        = arn:aws:iam::300000000003:role/ops-admin
source_profile  = platform

[profile platform-staging]
region          = eu-west-1
role_arn        = arn:aws:iam::400000000004:role/staging-admin
source_profile  = platform

[profile platform-production]
region          = eu-west-1
role_arn        = arn:aws:iam::500000000005:role/production-admin
source_profile  = platform
```

Clicking **Switch** on `platform-production` resolves the full chain:

```
org-sso (SSO device auth)
  → SSO credentials for account 100000000001
  → STS AssumeRole → platform (account 200000000002)
  → STS AssumeRole → platform-production (account 500000000005)
  → AWS Console Federation → new tab
```

### Supported profile fields

| Field | Description |
|---|---|
| `sso_start_url` | SSO portal URL (marks a profile as an SSO identity source) |
| `sso_account_id` | AWS account ID to access via SSO |
| `sso_role_name` | Permission set / role name in the SSO account |
| `sso_region` | Region of the SSO service |
| `role_arn` | ARN of the role to assume |
| `source_profile` | Parent profile to obtain credentials from |
| `role_session_name` | Session name used in AssumeRole calls |
| `external_id` | External ID required by the role's trust policy |
| `region` | AWS region (used for STS endpoint selection) |

## Known limitations

- When chaining via temporary credentials, AWS enforces a **maximum 1-hour session**. This matches the AWS CLI behaviour.
- The SSO device auth flow opens a new browser tab for login. After you authenticate, the extension resumes automatically.
- SSO tokens are cached in the extension's local storage (not shared with the AWS CLI's `~/.aws/sso/cache/`).

## How it works

```
Settings page  →  chrome.storage.sync (AWS config text)
                        ↓
                  background.js (service worker)
                  ┌─────────────────────────────┐
                  │ 1. Parse ~/.aws/config       │
                  │ 2. SSO OIDC device auth      │  ← oidc.{region}.amazonaws.com
                  │ 3. Get SSO role credentials  │  ← portal.sso.{region}.amazonaws.com
                  │ 4. STS AssumeRole (chain)    │  ← sts.{region}.amazonaws.com
                  │ 5. Federation getSigninToken │  ← signin.aws.amazon.com/federation
                  └─────────────────────────────┘
                        ↓
                  New browser tab → AWS Console (independent session)
```

All AWS API calls use **AWS Signature Version 4** implemented with the browser's native [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) — no external dependencies.

## Credits

Built by [Jakub Jindra](https://github.com/jindraj) with the help of **[Claude](https://claude.ai)** (Anthropic) — who wrote the entire extension, including the AWS Sig V4 implementation, SSO device auth flow, role chain resolver, federation URL builder, and all UI components.
