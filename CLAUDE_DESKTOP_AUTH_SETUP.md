# Claude Desktop Authentication Setup Guide

## Solution: Use mcp-remote proxy for Bearer Token Authentication

Claude Desktop supports authentication through the `mcp-remote` package, which acts as a proxy to add authentication headers to your MCP server requests.

## Step 1: Get Your OAuth Token

1. Open your browser and visit: http://localhost:3001/oauth/authorize
2. Login with your SAP BTP credentials
3. Copy the access token from the callback page
4. Save this token - you'll need it for the configuration

## Step 2: Install mcp-remote globally

```bash
npm install -g mcp-remote
```

## Step 3: Configure Claude Desktop

Edit your Claude Desktop configuration file:
`C:\Users\woute\AppData\Roaming\Claude\claude_desktop_config.json`

### Option A: Direct Bearer Token (Recommended)

```json
{
  "mcpServers": {
    "sap-odata": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3001/mcp",
        "--header",
        "Authorization:Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

**Note:** Replace `YOUR_TOKEN_HERE` with your actual token from Step 1.

### Option B: Using Environment Variable (More Secure)

```json
{
  "mcpServers": {
    "sap-odata": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3001/mcp",
        "--header",
        "Authorization:${SAP_AUTH_HEADER}"
      ],
      "env": {
        "SAP_AUTH_HEADER": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

### Option C: For Deployed Version

If you're using the deployed version on SAP BTP:

```json
{
  "mcpServers": {
    "sap-odata": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-app.cfapps.eu20.hana.ondemand.com/mcp",
        "--header",
        "Authorization:Bearer YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

## Step 4: Windows-Specific Fix

**Important for Windows:** There's a known issue with spaces in args. Notice we use `Authorization:Bearer` without spaces around the colon. The space between Bearer and the token is fine.

If you need spaces, use environment variables:

```json
{
  "mcpServers": {
    "sap-odata": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3001/mcp",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

## Step 5: Enable Debug Logging (Optional)

For troubleshooting, add the `--debug` flag:

```json
{
  "mcpServers": {
    "sap-odata": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3001/mcp",
        "--header",
        "Authorization:Bearer YOUR_TOKEN_HERE",
        "--debug"
      ]
    }
  }
}
```

This creates debug logs in `~/.mcp-auth/` directory.

## Step 6: Restart Claude Desktop

After updating the configuration:
1. Close Claude Desktop completely
2. Restart Claude Desktop
3. The MCP server should now connect with authentication

## Token Refresh

When your token expires (typically after 1 hour):
1. Get a new token from http://localhost:3001/oauth/authorize
2. Update the token in your `claude_desktop_config.json`
3. Restart Claude Desktop

## Alternative: Use Refresh Token

You can also implement automatic token refresh by creating a small script that refreshes the token:

```javascript
// refresh-token.js
const fs = require('fs');
const fetch = require('node-fetch');

async function refreshToken() {
  const response = await fetch('http://localhost:3001/oauth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'YOUR_REFRESH_TOKEN' })
  });
  
  const data = await response.json();
  return data.accessToken;
}

// Update config file with new token
async function updateConfig() {
  const newToken = await refreshToken();
  const configPath = 'C:\\Users\\woute\\AppData\\Roaming\\Claude\\claude_desktop_config.json';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  config.mcpServers['sap-odata'].env.SAP_AUTH_HEADER = `Bearer ${newToken}`;
  
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log('Token refreshed successfully!');
}

updateConfig();
```

## Troubleshooting

### If connection fails:
1. Verify your token is valid: `curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3001/oauth/userinfo`
2. Check mcp-remote is installed: `npx mcp-remote --version`
3. Check debug logs in `~/.mcp-auth/` directory
4. Ensure server is running: `curl http://localhost:3001/health`

### Common Issues:
- **401 Unauthorized**: Token is invalid or expired
- **404 Not Found**: Server URL is incorrect
- **Connection refused**: Server is not running
- **Spaces in header**: Use the environment variable approach

## Security Notes

- Never commit your tokens to version control
- Tokens typically expire after 1 hour
- Consider using environment variables instead of hardcoding tokens
- For production, use a service account with limited permissions

This setup allows Claude Desktop to authenticate with your SAP MCP server while maintaining security!