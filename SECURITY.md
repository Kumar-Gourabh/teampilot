# Security

## How TeamPilot handles access and data

- **Read-only to Microsoft 365.** Graph is used with delegated *read* scopes only. TeamPilot
  cannot edit, delete or send messages through Graph; it posts only through the webhooks you
  create.
- **Secrets stay in the workspace.** Webhook URLs and API keys live in the workspace `.env`
  (created with mode 600); the Microsoft token cache lives in `secrets/` (mode 700). Neither is
  ever logged or written into state.
- **No telemetry.** TeamPilot talks only to Microsoft Graph, your webhook endpoints and the AI
  provider you configure.
- **What reaches the AI provider:** the standup messages being summarised, leave announcements
  being read, and the names in your people directory. Use `llm.provider: none` to keep
  everything on your host.
- **Workspaces are isolated.** Each workspace has its own secrets, token cache and state; one
  workspace's jobs never read another's.

## Reporting a vulnerability

Please email **kumargourabh94@gmail.com** with details rather than opening a public issue.
