# Deployment Guide — ADO → Google Chat Notifier (Azure Function)

This Azure Function listens for Azure DevOps `workitem.created` service hook events and posts a
card notification to a Google Chat space whenever a **User Story** is created under a configured
area path prefix.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Azure Resources Required](#2-azure-resources-required)
3. [App Settings (Environment Variables)](#3-app-settings-environment-variables)
4. [Testing Locally Before Deploying](#4-testing-locally-before-deploying)
5. [Deploy to Azure](#5-deploy-to-azure)
6. [Configure the ADO Service Hook](#6-configure-the-ado-service-hook)
7. [Testing After Deployment](#7-testing-after-deployment)
8. [Expected Request and Response Format](#8-expected-request-and-response-format)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Prerequisites

Install the following tools before proceeding:

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20 LTS or later | https://nodejs.org |
| Azure Functions Core Tools | v4 | `npm install -g azure-functions-core-tools@4 --unsafe-perm true` |
| Azure CLI | Latest | https://learn.microsoft.com/en-us/cli/azure/install-azure-cli |

Verify installs:
```bash
node --version        # should be 20.x or higher
func --version        # should be 4.x
az --version          # any recent version
```

---

## 2. Azure Resources Required

You need the following resources in Azure before deploying. Create them in the Azure Portal or via CLI.

### 2a. Resource Group (if one doesn't exist)
```bash
az group create --name <resource-group-name> --location eastus
```

### 2b. Storage Account (required by Azure Functions runtime)
```bash
az storage account create \
  --name <storage-account-name> \
  --resource-group <resource-group-name> \
  --location eastus \
  --sku Standard_LRS
```

### 2c. Function App
```bash
az functionapp create \
  --name <function-app-name> \
  --resource-group <resource-group-name> \
  --storage-account <storage-account-name> \
  --consumption-plan-location eastus \
  --runtime node \
  --runtime-version 20 \
  --functions-version 4 \
  --os-type Linux
```

> **Note:** The function app name must be globally unique across Azure. It becomes part of the URL:
> `https://<function-app-name>.azurewebsites.net`

---

## 3. App Settings (Environment Variables)

These two settings **must** be configured in the Function App before it will work.
Do not put real values in `local.settings.json` when committing — that file is gitignored and
is for local testing only.

| Setting | Description | Example |
|---------|-------------|---------|
| `GOOGLE_CHAT_WEBHOOK_URL` | Incoming webhook URL from the target Google Chat space. Get it from the space: click the space name → **Manage webhooks** → **Add webhook**. | `https://chat.googleapis.com/v1/spaces/AAAA.../messages?key=...` |
| `TARGET_AREA_PATH` | ADO area path prefix to watch. User Stories created outside this path are silently ignored. Use a single backslash in Azure — the app normalizes double backslashes automatically. | `MyProject\Hotfix` |

### Set via Azure CLI
```bash
az functionapp config appsettings set \
  --name <function-app-name> \
  --resource-group <resource-group-name> \
  --settings \
    "GOOGLE_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/..." \
    "TARGET_AREA_PATH=MyProject\Hotfix"
```

### Set via Azure Portal
1. Open the Function App in the portal
2. Go to **Settings → Environment variables**
3. Click **+ Add** for each setting above
4. Click **Apply** then **Confirm**

---

## 4. Testing Locally Before Deploying

### 4a. Install dependencies
```bash
cd azure-function-google-chat-notifier
npm install
```

### 4b. Configure local settings
Edit `local.settings.json` and fill in real values (this file is gitignored):
```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "GOOGLE_CHAT_WEBHOOK_URL": "https://chat.googleapis.com/v1/spaces/.../messages?key=...",
    "TARGET_AREA_PATH": "MyProject\\Hotfix"
  }
}
```

> **Note:** In `local.settings.json` use double backslashes (`\\`) for the area path. Azure app
> settings use single backslashes.

### 4c. Start the function locally
```bash
func start
```

You should see output like:
```
Functions:
    notifyGoogleChat: [POST] http://localhost:7071/api/notifyGoogleChat
```

### 4d. Send a test payload
In a separate terminal, send a minimal ADO `workitem.created` payload:

```bash
curl -X POST http://localhost:7071/api/notifyGoogleChat \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "workitem.created",
    "resource": {
      "id": 99999,
      "fields": {
        "System.WorkItemType": "User Story",
        "System.AreaPath": "MyProject\\Hotfix",
        "System.Title": "Test story from local",
        "System.State": "New",
        "System.TeamProject": "MyProject",
        "System.AssignedTo": { "displayName": "Jane Doe" },
        "Microsoft.VSTS.Common.Priority": "2"
      }
    },
    "resourceContainers": {
      "account": { "baseUrl": "https://dev.azure.com/my-org/" }
    }
  }'
```

**Expected response:** `{"message":"Notification sent."}` and a card appears in Google Chat.

To test the filters (should return 200 with no notification):
```bash
# Wrong event type — ignored
curl -X POST http://localhost:7071/api/notifyGoogleChat \
  -H "Content-Type: application/json" \
  -d '{"eventType": "workitem.updated"}'

# Wrong work item type — ignored
curl -X POST http://localhost:7071/api/notifyGoogleChat \
  -H "Content-Type: application/json" \
  -d '{"eventType":"workitem.created","resource":{"id":1,"fields":{"System.WorkItemType":"Bug","System.AreaPath":"MyProject\\Hotfix","System.Title":"A bug","System.TeamProject":"MyProject"}}}'

# Wrong area path — ignored
curl -X POST http://localhost:7071/api/notifyGoogleChat \
  -H "Content-Type: application/json" \
  -d '{"eventType":"workitem.created","resource":{"id":1,"fields":{"System.WorkItemType":"User Story","System.AreaPath":"OtherProject\\Sprint1","System.Title":"A story","System.TeamProject":"OtherProject"}}}'
```

---

## 5. Deploy to Azure

### Option A: Azure Functions Core Tools (recommended)

```bash
cd azure-function-google-chat-notifier
npm install
func azure functionapp publish <function-app-name> --node
```

That's it. Core Tools packages the project, runs `npm install --production` remotely, and deploys.

### Option B: Azure CLI with ZIP deploy

```bash
cd azure-function-google-chat-notifier
npm install --omit=dev
zip -r function.zip . --exclude "local.settings.json" --exclude ".git/*" --exclude "DEPLOYMENT.md" --exclude "*.test.js"

az functionapp deployment source config-zip \
  --name <function-app-name> \
  --resource-group <resource-group-name> \
  --src function.zip
```

### Option C: Azure Portal (manual)

1. In the portal, open the Function App
2. Go to **Deployment Center**
3. Choose your source (GitHub, Azure Repos, or local Git)
4. Follow the prompts to connect and deploy

---

## 6. Configure the ADO Service Hook

After the function is deployed and app settings are configured:

1. In Azure DevOps, go to **Project Settings → Service hooks → Create subscription**
2. Select **Web Hooks**, click **Next**
3. Set **Event** to `Work item created`
4. Optionally filter by **Area path** and/or **Work item type** at the ADO level as well
5. Click **Next**
6. Set the **URL** to your function endpoint (see below for how to get it)
7. Add the function key as a header (see below)
8. Set **Resource details to send** to `All`
9. Click **Test** to verify, then **Finish**

### Getting the Function URL and Key

#### Via Azure Portal
1. Open the Function App → **Functions** → **notifyGoogleChat**
2. Click **Get function URL**
3. Select key `default (Function key)` — copy the full URL including `?code=...`

#### Via Azure CLI
```bash
# Get the function key
az functionapp keys list \
  --name <function-app-name> \
  --resource-group <resource-group-name>

# The function URL is:
# https://<function-app-name>.azurewebsites.net/api/notifyGoogleChat
```

### ADO Service Hook Configuration Summary

| Field | Value |
|-------|-------|
| **Event** | Work item created |
| **URL** | `https://<function-app-name>.azurewebsites.net/api/notifyGoogleChat` |
| **HTTP header name** | `x-functions-key` |
| **HTTP header value** | `<your-function-key>` |
| **Resource details** | All |
| **Messages to send** | All |

> Passing the key as a header (`x-functions-key`) is preferred over appending `?code=` to the
> URL so the key doesn't appear in logs.

---

## 7. Testing After Deployment

Use the full Azure URL. The function key goes in the header:

```bash
curl -X POST "https://<function-app-name>.azurewebsites.net/api/notifyGoogleChat" \
  -H "Content-Type: application/json" \
  -H "x-functions-key: <your-function-key>" \
  -d '{
    "eventType": "workitem.created",
    "resource": {
      "id": 99999,
      "fields": {
        "System.WorkItemType": "User Story",
        "System.AreaPath": "MyProject\\Hotfix",
        "System.Title": "Post-deploy smoke test",
        "System.State": "New",
        "System.TeamProject": "MyProject",
        "System.AssignedTo": { "displayName": "Jane Doe" },
        "Microsoft.VSTS.Common.Priority": "1"
      }
    },
    "resourceContainers": {
      "account": { "baseUrl": "https://dev.azure.com/my-org/" }
    }
  }'
```

A card should appear in the configured Google Chat space within a few seconds.

---

## 8. Expected Request and Response Format

### Request
- **Method:** POST
- **Content-Type:** application/json
- **Auth:** `x-functions-key: <function-key>` header (or `?code=<key>` query param)
- **Body:** Standard ADO `workitem.created` service hook payload (sent automatically by ADO)

### Responses

| Scenario | HTTP Status | Body |
|----------|------------|------|
| Notification sent successfully | 200 | `{"message":"Notification sent."}` |
| Event type is not `workitem.created` | 200 | `{"message":"Event ignored."}` |
| Work item type is not User Story | 200 | `{"message":"Not a User Story."}` |
| Area path does not match | 200 | `{"message":"Area path does not match."}` |
| Invalid JSON body | 400 | `{"error":"Invalid JSON body."}` |
| Missing app settings | 500 | `{"error":"Function misconfiguration: missing app settings."}` |
| Google Chat POST failed | 500 | `{"error":"Failed to notify Google Chat.","details":"..."}` |

> ADO service hooks retry on any non-2xx response. The function returns 200 for all ignored events
> to prevent unnecessary retries from ADO.

---

## 9. Troubleshooting

### Function returns 500 "Function misconfiguration: missing app settings"
- Verify `GOOGLE_CHAT_WEBHOOK_URL` and `TARGET_AREA_PATH` are set in **Configuration → App settings**
- After adding settings, the function restarts automatically — wait ~30 seconds and retry

### Notification not appearing in Google Chat
- Confirm the `GOOGLE_CHAT_WEBHOOK_URL` is correct and the webhook is still active in the Chat space
- Check function logs: portal → Function App → **Monitor** → **Logs** or **Invocations**
- Verify the work item is a **User Story** (not a Bug, Task, etc.)
- Verify the area path starts with `TARGET_AREA_PATH` (case-insensitive)

### ADO service hook shows failures / not triggering
- Open the service hook in ADO → check the **History** tab for error details
- Confirm the function URL is correct and the function key header is set
- Test the function directly with curl (see section 7) to rule out Azure issues

### Area path filter not matching
- In Azure app settings, use a **single backslash**: `MyProject\Hotfix`
- In `local.settings.json`, use a **double backslash**: `MyProject\\Hotfix`
- The function normalizes both forms automatically

### Viewing logs in Azure
```bash
# Stream live logs
func azure functionapp logstream <function-app-name>

# Or via CLI
az webapp log tail \
  --name <function-app-name> \
  --resource-group <resource-group-name>
```
