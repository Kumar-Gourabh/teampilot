# Microsoft 365 setup

TeamPilot touches Teams in two ways:

| | How | Needs |
|---|---|---|
| **Posting cards** | Teams **Workflows** webhooks (Power Automate) | one webhook URL per venue |
| **Reading replies, chats, reactions** | Microsoft **Graph**, signed in as an account | a one-time device-code sign-in |

## 1. Choose the account TeamPilot reads as

Use a **dedicated service account** (for example teampilot@yourcompany.com) rather than a person:

- It must be a **member of every channel's team and every chat** TeamPilot reads. If it isn't,
  reads fail with a 403. The supervisor reports this.
- If someone resets that account's password, the sign-in is revoked and every read stops until
  someone signs in again. Keep the account out of routine password rotation, or plan a
  re-login whenever it rotates.
- Optional: you can set a second, **read-only fallback** identity under
  **identity.graph.fallback**. It's used only when the main account is refused a read. It is
  never used for anything else.

## 2. App registration (recommended for production)

Out of the box, TeamPilot signs in through Microsoft's public **Graph Command Line Tools**
app, so you don't need an app registration. Many tenants require admin consent for it.

For a production or customer deployment, register your own app:

1. In **Entra admin center → App registrations → New registration**, use the name "TeamPilot"
   and choose single tenant.
2. Under **Authentication**, set **Allow public client flows** to Yes (this is needed for
   device-code sign-in).
3. Under **API permissions → Microsoft Graph → Delegated**, add:
   - User.Read
   - User.ReadBasic.All
   - Team.ReadBasic.All
   - Channel.ReadBasic.All
   - ChannelMessage.Read.All
   - Chat.Read
4. **Grant admin consent.** ChannelMessage.Read.All and Chat.Read require it.
5. Put the app's ids in **workspace.yaml**:
   ```yaml
   identity:
     graph:
       tenant: <directory (tenant) id>
       clientId: <application (client) id>
       account: teampilot@yourcompany.com
   ```

Then sign in:

```
teampilot login <workspace>
```

Open the link it prints and enter the code, signed in as the service account. The token cache
is saved in the workspace's **secrets/** folder, readable only by the owner. Refresh is silent
from then on. A scheduled job never prompts.

## 3. One Workflows webhook per venue

For each channel or chat TeamPilot posts to:

1. In Teams, open the channel or chat → **⋯** → **Workflows**.
2. Choose **"Send webhook alerts to a channel"** or **"… to a chat"**. The wording varies by
   tenant. Any template that posts the incoming card works.
3. Create it **as the service account**. A flow owned by a person stops working when they
   leave, and it can fail silently.
4. Copy the URL into the workspace **.env** under the name the venue uses:
   ```
   WEBHOOK_STANDUP=https://...
   ```

Workflows webhooks support real **@mentions**. Classic Office 365 connector webhooks don't, so
set **kind: teams-connector** for those and names will appear in bold instead.

> A webhook replying 202 only means the request was **accepted**. A broken or disabled flow
> still returns 202. That's why the supervisor reads each venue back to confirm the card
> really appeared.

## 4. Find the ids

```
teampilot discover <workspace>
```

This lists every team, channel and chat the account can see, with their ids. Put
**teamId + channelId** (for a channel) or **chatId** (for a chat) on each venue that
TeamPilot needs to **read**:

- standup intake
- timesheet confirmations
- leave sources
- every venue the supervisor should verify

Venues that are only posted to don't need ids.

## 5. Verify

```
teampilot doctor <workspace> --online
```
