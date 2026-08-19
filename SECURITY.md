# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/jhbarnett/bb-autobahn/security/advisories/new). Do not open a public issue for an unpatched vulnerability.

Include the affected version or commit, the required conditions, a minimal reproduction, and the impact. Do not include real credentials, private repository content, or other users data.

## Security model

Autobahn is a full-trust bb plugin. Installing it grants the plugin access to the bb SDK, thread metadata, environments, and its own plugin storage. Install only source you trust and review updates before applying them.

Autobahn does not store GitHub credentials. Tracker operations are delegated to the official bb GitHub plugin, and model-initiated issue creation requires an explicit human confirmation. Roadmap snooze and Closed-lane clearing change only Autobahn display state; the broom never archives or deletes threads.

Fresh planning and verification agents run in disposable branch-backed managed worktrees, use the safest supported `accept-edits` permission mode, and receive no Autobahn mutation tools. They are still ordinary bb coding-agent sessions: provider-standard shell, network, and filesystem capabilities remain governed by the owners bb machine and permission policies. Managed-worktree isolation protects the controller branch; it is not a confidentiality sandbox for hostile repositories.

## Supported versions

Until the first tagged release, only the latest commit on the default branch receives security fixes.
