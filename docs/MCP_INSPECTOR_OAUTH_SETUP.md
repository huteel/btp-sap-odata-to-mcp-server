# MCP Inspector OAuth 2.0 Configuration for SAP BTP XSUAA

## Overview
This guide explains how to configure MCP Inspector's built-in OAuth 2.0 flow to work with SAP BTP XSUAA.

## The Challenge
MCP Inspector's OAuth flow expects standard OAuth 2.0 endpoints, but XSUAA has specific requirements:
- Requires exact redirect URI matching
- Uses specific grant types
- Needs proper client authentication

## Working Methods

### Method 1: Manual Token (Currently Working) ✅
1. Get token via browser: `http://localhost:3000/oauth/authorize`
2. Copy the token from the callback page
3. Use in MCP Inspector with Authorization header

### Method 2: MCP Inspector OAuth Flow (Configuration Required) ⚠️

The MCP Inspector OAuth flow fails because:
1. **Redirect URI Mismatch**: MCP Inspector uses its own redirect URI (typically `http://localhost:PORT/oauth/callback`), but XSUAA only allows pre-configured URIs
2. **Client Authentication**: XSUAA requires client_secret for the token exchange
3. **Grant Type**: Must use `authorization_code` grant type

## Fixing MCP Inspector OAuth Flow

### Option 1: Use OAuth Proxy (Recommended) ✅

**The server now includes an OAuth proxy that solves the redirect URI issue automatically!**

1. **Configure MCP Inspector OAuth 2.0 Flow**:
   - **Authorization URL**: `http://localhost:3000/oauth/mcp-inspector/authorize` (or your server URL)
   - **Token URL**: `https://[your-xsuaa-url]/oauth/token` (not used due to proxy)
   - **Client ID**: Your XSUAA client ID  
   - **Client Secret**: Leave empty (proxy handles this)
   - **Scope**: `openid profile email uaa.user uaa.resource [your-app-scopes]`
   - **Redirect URI**: Keep MCP Inspector's default

2. **How it works**:
   - MCP Inspector redirects to `/oauth/mcp-inspector/authorize` with its callback URI
   - Server stores MCP Inspector's callback info and redirects to XSUAA
   - After XSUAA authentication, server exchanges code for token
   - Server redirects back to MCP Inspector with the token in URL fragment

### Option 2: Configure XSUAA for MCP Inspector (Alternative)

**Note: This approach has limitations with wildcard URIs in XSUAA**

1. **Update xs-security.json** to include MCP Inspector's redirect URI:
```json
{
  "oauth2-configuration": {
    "redirect-uris": [
      "https://*.cfapps.*.hana.ondemand.com/**",
      "http://localhost:3000/oauth/callback",
      "http://localhost:*/callback",  // For MCP Inspector
      "http://127.0.0.1:*/callback"    // Alternative localhost
    ]
  }
}
```

2. **Redeploy to SAP BTP** to update XSUAA configuration

3. **Configure MCP Inspector OAuth**:
   - **Authorization URL**: `https://[your-xsuaa-url]/oauth/authorize`
   - **Token URL**: `https://[your-xsuaa-url]/oauth/token`
   - **Client ID**: Your XSUAA client ID
   - **Client Secret**: Your XSUAA client secret
   - **Scope**: Leave empty or use `openid`

### Option 3: Use Client Credentials Flow (For Testing)

If you just need to test without user context:

1. **Configure MCP Inspector**:
   - **Grant Type**: `client_credentials`
   - **Token URL**: `https://[your-xsuaa-url]/oauth/token`
   - **Client ID**: Your XSUAA client ID
   - **Client Secret**: Your XSUAA client secret

## Current Workaround (Recommended)

Since the manual token method works, continue using:

1. **Browser OAuth Flow**:
   ```
   http://localhost:3000/oauth/authorize
   ```

2. **Copy Token** from the success page

3. **Use in MCP Inspector**:
   - Server URL: `http://localhost:3000/mcp`
   - Headers: `Authorization: Bearer [YOUR_TOKEN]`

## Why This Happens

The XSUAA error "The request for authorization was invalid" occurs because:

1. **Redirect URI Validation**: XSUAA strictly validates redirect URIs. MCP Inspector likely uses a dynamic port or different path than what's registered in xs-security.json

2. **Missing Parameters**: XSUAA might require additional parameters like:
   - `response_type=code`
   - `state` parameter for CSRF protection
   - Specific `scope` values

3. **Client Authentication**: The token exchange requires client_secret, which MCP Inspector might not be sending correctly

## Best Practice

For production use:
1. Use the browser-based flow for user authentication
2. Store tokens securely
3. Implement token refresh logic
4. Use the OAuth status dashboard at `/oauth/status` for monitoring

## Quick Reference

### Working Endpoints
- **Authorization (Direct)**: `http://localhost:3000/oauth/authorize`
- **Authorization (MCP Inspector Proxy)**: `http://localhost:3000/oauth/mcp-inspector/authorize`
- **Callback**: `http://localhost:3000/oauth/callback`
- **Status Dashboard**: `http://localhost:3000/oauth/status`
- **Token Info**: `http://localhost:3000/oauth/userinfo`

### XSUAA Configuration
- **Client ID**: `sb-btp-sap-odata-to-mcp-server-development!t110207`
- **Auth URL**: `https://infrabel-app-dev.authentication.eu20.hana.ondemand.com/oauth/authorize`
- **Token URL**: `https://infrabel-app-dev.authentication.eu20.hana.ondemand.com/oauth/token`

### MCP Inspector Connection
```bash
npx @modelcontextprotocol/inspector "http://localhost:3000/mcp" \
  --header "Authorization: Bearer YOUR_TOKEN_HERE"
```