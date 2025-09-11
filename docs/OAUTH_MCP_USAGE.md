# Using OAuth Authentication with MCP Inspector

This guide explains how to use the OAuth authentication flow with the MCP Inspector to connect to your SAP OData services securely.

## Prerequisites

1. Server running with OAuth configured (`npm run start:http`)
2. XSUAA service configured in SAP BTP
3. Two destinations configured in SAP BTP:
   - Discovery destination (technical user)
   - Execution destination (principal propagation)

## Step 1: Obtain an Access Token

### Option A: Browser-Based OAuth Flow (Recommended)

1. Open your browser and navigate to:
   ```
   http://localhost:3000/oauth/authorize
   ```

2. You'll be redirected to the SAP BTP login page
3. Enter your SAP credentials
4. After successful login, you'll be redirected back to:
   ```
   http://localhost:3000/oauth/callback?code=<auth_code>
   ```

5. The response will contain your access token:
   ```json
   {
     "accessToken": "eyJhbGciOiJSUzI1NiIs...",
     "expiresIn": 3600,
     "message": "Authentication successful. Use the access token in the Authorization header for API calls."
   }
   ```

6. **Copy the `accessToken` value** - you'll need it for the MCP Inspector

### Option B: Direct API Call (if you have credentials)

If you already have client credentials, you can get a token directly:

```bash
curl -X POST https://your-xsuaa-url.authentication.region.hana.ondemand.com/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```

## Step 2: Configure MCP Inspector with Authentication

### Method 1: Using Custom Headers (Recommended)

1. Open MCP Inspector
2. Configure the connection:
   ```
   Server URL: http://localhost:3000/mcp
   ```

3. In the MCP Inspector, look for the "Headers" or "Custom Headers" section
4. Add the Authorization header:
   ```
   Authorization: Bearer YOUR_ACCESS_TOKEN_HERE
   ```

### Method 2: Using Environment Variables

1. Set the token as an environment variable before starting the inspector:
   ```bash
   export USER_JWT="YOUR_ACCESS_TOKEN_HERE"
   npx @modelcontextprotocol/inspector http://localhost:3000/mcp
   ```

### Method 3: Modified Inspector URL (if supported)

Some MCP clients support passing headers in the URL:
```
npx @modelcontextprotocol/inspector "http://localhost:3000/mcp" \
  --header "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE"
```

## Step 3: Test the Connection

1. Once connected with the token, the MCP Inspector should show:
   - Available tools (search-sap-services, discover-service-entities, etc.)
   - Service metadata resources

2. Test authentication by:
   - Searching for services: Use `search-sap-services`
   - Executing operations: Use `execute-entity-operation`

3. Check user info endpoint to verify authentication:
   ```bash
   curl http://localhost:3000/oauth/userinfo \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE"
   ```

## Step 4: Token Refresh

Tokens expire after a certain period (default: 1 hour). To refresh:

1. If you received a refresh token during login:
   ```bash
   curl -X POST http://localhost:3000/oauth/refresh \
     -H "Content-Type: application/json" \
     -d '{"refreshToken": "YOUR_REFRESH_TOKEN"}'
   ```

2. Otherwise, repeat Step 1 to get a new token

## Troubleshooting

### Common Issues

1. **"No valid authorization header found"**
   - Ensure the token is prefixed with "Bearer "
   - Check token hasn't expired

2. **"XSUAA service not configured"**
   - Verify VCAP_SERVICES environment variable is set
   - Check xs-security.json configuration

3. **Token validation failed**
   - Token may be expired - get a new one
   - Ensure XSUAA credentials are correct

### Debug Mode

Enable debug logging to see authentication details:
```bash
LOG_LEVEL=debug npm run start:http
```

## Security Notes

1. **Never share your access tokens** - they provide full access to your SAP data
2. **Tokens expire** - default is 1 hour for access tokens, 24 hours for refresh tokens
3. **Use HTTPS in production** - tokens should only be transmitted over secure connections
4. **Different destinations** - Discovery uses technical user, execution uses your JWT

## Environment Configuration

For production, configure these environment variables:

```env
# Separate destinations for discovery and execution
SAP_DISCOVERY_DESTINATION_NAME=SAP_TECHNICAL_USER
SAP_EXECUTION_DESTINATION_NAME=SAP_PRINCIPAL_PROPAGATION

# OAuth configuration
OAUTH_REDIRECT_BASE_URL=https://your-app-url.com
```

## API Endpoints Reference

- **GET /oauth/authorize** - Start OAuth flow
- **GET /oauth/callback** - OAuth callback (receives auth code)
- **POST /oauth/refresh** - Refresh access token
- **GET /oauth/userinfo** - Get authenticated user info
- **POST /mcp** - Main MCP endpoint (requires Bearer token)

## Example: Complete Flow with MCP Inspector

```bash
# Step 1: Get token via browser
# Navigate to http://localhost:3000/oauth/authorize
# Copy the accessToken from the callback response

# Step 2: Start MCP Inspector with token
npx @modelcontextprotocol/inspector

# Step 3: In Inspector UI:
# - Enter URL: http://localhost:3000/mcp
# - Add Header: Authorization: Bearer <your-token>
# - Click Connect

# Step 4: Use the tools
# - search-sap-services to find services
# - discover-service-entities to explore entities
# - execute-entity-operation to perform CRUD operations
```

The JWT token ensures that:
- API discovery uses the technical user (reliable, always available)
- Data operations use your personal credentials (proper authorization, audit trail)