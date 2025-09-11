import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import 'dotenv/config';

import { MCPServer, createMCPServer } from './mcp-server.js';
import { Logger } from './utils/logger.js';
import { Config } from './utils/config.js';
import { DestinationService } from './services/destination-service.js';
import { SAPClient } from './services/sap-client.js';
import { SAPDiscoveryService } from './services/sap-discovery.js';
import { ODataService } from './types/sap-types.js';
import { ServiceDiscoveryConfigService } from './services/service-discovery-config.js';
import { AuthService, AuthRequest } from './services/auth-service.js';
import { OAuthIntegrationService } from './services/oauth-integration.js';

/**
 * Modern Express server hosting SAP MCP Server with session management
 * 
 * This server provides HTTP transport for the SAP MCP server using the
 * latest streamable HTTP transport with proper session management.
 */

const logger = new Logger('btp-sap-odata-to-mcp-server');
const config = new Config();
const destinationService = new DestinationService(logger, config);
const sapClient = new SAPClient(destinationService, logger);
const sapDiscoveryService = new SAPDiscoveryService(sapClient, logger, config);
const serviceConfigService = new ServiceDiscoveryConfigService(config, logger);
const authService = new AuthService(logger, config);
let discoveredServices: ODataService[] = [];

// Session storage for HTTP transport with user context
const sessions: Map<string, {
    server: MCPServer;
    transport: StreamableHTTPServerTransport;
    createdAt: Date;
    userToken?: string;
    userId?: string;
}> = new Map();

/**
 * Clean up expired sessions (older than 24 hours)
 */
function cleanupExpiredSessions(): void {
    const now = new Date();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    for (const [sessionId, session] of sessions.entries()) {
        if (now.getTime() - session.createdAt.getTime() > maxAge) {
            logger.info(`🧹 Cleaning up expired session: ${sessionId}`);
            session.transport.close();
            sessions.delete(sessionId);
        }
    }
}

/**
 * Get or create a session for the given session ID with optional user context
 */
async function getOrCreateSession(sessionId?: string, userToken?: string): Promise<{
    sessionId: string;
    server: MCPServer;
    transport: StreamableHTTPServerTransport;
}> {
    // Check for existing session
    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        logger.debug(`♻️  Reusing existing session: ${sessionId}`);
        return {
            sessionId,
            server: session.server,
            transport: session.transport
        };
    }

    // Create new session
    const newSessionId = sessionId || randomUUID();
    logger.info(`🆕 Creating new MCP session: ${newSessionId}`);

    try {
        // Create and initialize MCP server with user token if available
        const mcpServer = await createMCPServer(discoveredServices, userToken);

        // Create HTTP transport
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (id) => {
                logger.debug(`✅ Session initialized: ${id}`);
            },
            enableDnsRebindingProtection: false,  // Disable for MCP inspector compatibility
            allowedHosts: ['127.0.0.1', 'localhost']
        });

        // Connect server to transport
        await mcpServer.getServer().connect(transport);

        // Store session with user context if provided
        sessions.set(newSessionId, {
            server: mcpServer,
            transport,
            createdAt: new Date(),
            userToken: userToken
        });

        // Clean up session when transport closes
        transport.onclose = () => {
            logger.info(`🔌 Transport closed for session: ${newSessionId}`);
            sessions.delete(newSessionId);
        };

        logger.info(`🎉 Session created successfully: ${newSessionId}`);
        return {
            sessionId: newSessionId,
            server: mcpServer,
            transport
        };

    } catch (error) {
        logger.error(`❌ Failed to create session: ${error}`);
        throw error;
    }
}

/**
 * Create Express application
 */
export function createApp(): express.Application {
    const app = express();

    // Security and parsing middleware
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                scriptSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "https:"]
            }
        }
    }));

    app.use(cors({
        origin: process.env.NODE_ENV === 'production'
            ? ['https://your-domain.com'] // Configure for production
            : true, // Allow all origins in development
        credentials: true,
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'MCP-Protocol-Version']
    }));

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // Serve static files from public directory
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    app.use('/public', express.static(path.join(__dirname, 'public')));

    // Request logging middleware
    app.use((req, res, next) => {
        logger.debug(`📨 ${req.method} ${req.path}`, {
            sessionId: req.headers['mcp-session-id'],
            userAgent: req.headers['user-agent']
        });
        next();
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            activeSessions: sessions.size,
            version: process.env.npm_package_version || '1.0.0'
        });
    });

    // MCP server info endpoint - Authentication-aware response
    app.get('/mcp', authService.optionalAuthenticateJWT() as express.RequestHandler, (req, res) => {
        const authReq = req as AuthRequest;
        const isAuthenticated = !!authReq.authInfo;
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        // Build authentication-aware response
        const serverInfo: any = {
            name: 'btp-sap-odata-to-mcp-server',
            version: '2.0.0',
            description: 'Modern MCP server for SAP OData services with dynamic CRUD operations and OAuth authentication',
            protocol: {
                version: '2025-06-18',
                transport: 'streamable-http'
            },
            capabilities: {
                tools: { listChanged: true },
                resources: { listChanged: true },
                logging: {}
            },
            features: [
                'OAuth authentication with SAP XSUAA',
                'Dynamic SAP OData service discovery',
                'CRUD operations for all discovered entities', 
                'JWT token forwarding for secure operations',
                'Dual destination support (discovery vs execution)',
                'Natural language query support',
                'Session-based HTTP transport',
                'Real-time service metadata'
            ],
            authentication: {
                type: 'OAuth 2.0 / XSUAA',
                required: true,
                status: isAuthenticated ? 'authenticated' : 'not_authenticated',
                ...(isAuthenticated ? {
                    user: authReq.authInfo ? {
                        username: authReq.authInfo.getUserName(),
                        email: authReq.authInfo.getEmail(),
                        // scopes: authReq.authInfo.getGrantedScopes()
                    } : undefined,
                    message: 'You are authenticated and ready to access SAP services'
                } : {
                    message: 'Authentication required to access SAP OData services',
                    instructions: {
                        step1: `Visit ${baseUrl}/oauth/authorize to start OAuth flow`,
                        step2: 'Login with SAP BTP credentials',
                        step3: 'Copy access token from callback',
                        step4: 'Use token in Authorization header for MCP requests'
                    },
                    endpoints: {
                        authorize: `${baseUrl}/oauth/authorize`,
                        discovery: `${baseUrl}/.well-known/oauth-authorization-server`
                    }
                })
            },
            userGuidance: {
                gettingStarted: [
                    '1. Authenticate: Navigate to /oauth/authorize to get your access token',
                    '2. Connect: Use the token in Authorization header for MCP requests',
                    '3. Discover: Start with search-sap-services to find available SAP services',
                    '4. Explore: Use discover-service-entities to see what data is available',
                    '5. Execute: Use execute-entity-operation to read, create, update, or delete data'
                ],
                availableOperations: [
                    'Search and filter SAP OData services by category or keyword',
                    'Discover entities and their properties within services',
                    'Read entity collections with OData query options ($filter, $select, etc.)',
                    'Read individual entities by key',
                    'Create new entities with proper validation',
                    'Update existing entities (PATCH operations)',
                    'Delete entities with proper authorization'
                ],
                bestPractices: [
                    'Always start with search-sap-services to understand available data',
                    'Use discover-service-entities before attempting CRUD operations',
                    'Check entity capabilities (creatable, updatable, deletable) before operations',
                    'Use OData query options to filter and limit data retrieval',
                    'JWT tokens expire - refresh when needed via /oauth/refresh'
                ]
            },
            endpoints: {
                health: '/health',
                mcp: '/mcp',
                auth: '/oauth/authorize',
                userinfo: '/oauth/userinfo',
                docs: '/docs'
            },
            activeSessions: sessions.size,
            claude_ai_guidance: isAuthenticated ? {
                status: 'Ready to assist with SAP operations',
                available_tools: [
                    'search-sap-services: Find SAP services by category',
                    'discover-service-entities: Explore service entities',
                    'get-entity-schema: Get entity structure details',
                    'execute-entity-operation: Perform CRUD operations'
                ],
                next_steps: [
                    'Start with search-sap-services to discover available data',
                    'Use discover-service-entities to understand service capabilities',
                    'Execute operations with proper user authorization'
                ]
            } : {
                status: 'Authentication required before I can help with SAP operations',
                action_required: 'User must authenticate via OAuth flow',
                guidance: [
                    'Direct user to authenticate first via OAuth',
                    'Explain the dual authentication model',
                    'Provide clear step-by-step authentication instructions',
                    'Wait for user to complete authentication before attempting SAP operations'
                ],
                authentication_priority: 'CRITICAL - Do not attempt SAP operations without authentication'
            }
        };
        
        res.json(serverInfo);
    });

    // Main MCP endpoint - handles all MCP communication
    // SECURITY: Requires authentication for all MCP operations to ensure user context and audit trail
    app.post('/mcp', authService.authenticateJWT() as express.RequestHandler, async (req, res) => {
        const authReq = req as AuthRequest;
        try {
            // Get session ID from header
            const sessionId = authReq.headers['mcp-session-id'] as string | undefined;
            let session;

            if (sessionId && sessions.has(sessionId)) {
                // Reuse existing session
                session = await getOrCreateSession(sessionId, authReq.jwtToken);
            } else if (!sessionId && isInitializeRequest(authReq.body)) {
                // New initialization request with user token if available
                session = await getOrCreateSession(undefined, authReq.jwtToken);
            } else {
                // Invalid request
                logger.warn(`❌ Invalid MCP request - no session ID and not initialize request`);
                return res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided or not an initialize request'
                    },
                    id: authReq.body?.id || null
                });
            }

            // Handle the request
            await session.transport.handleRequest(authReq, res, authReq.body);

        } catch (error) {
            logger.error('❌ Error handling MCP request:', error);

            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`
                    },
                    id: authReq.body?.id || null
                });
            }
        }
    });

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', async (req, res) => {
        try {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            if (!sessionId || !sessions.has(sessionId)) {
                logger.warn(`❌ Invalid session ID for SSE: ${sessionId}`);
                return res.status(400).json({
                    error: 'Invalid or missing session ID'
                });
            }

            const session = sessions.get(sessionId)!;
            await session.transport.handleRequest(req, res);

        } catch (error) {
            logger.error('❌ Error handling SSE request:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    // Handle session termination
    app.delete('/mcp', async (req, res) => {
        try {
            const sessionId = req.headers['mcp-session-id'] as string | undefined;

            if (!sessionId || !sessions.has(sessionId)) {
                logger.warn(`❌ Cannot terminate - invalid session ID: ${sessionId}`);
                return res.status(400).json({
                    error: 'Invalid or missing session ID'
                });
            }

            const session = sessions.get(sessionId)!;

            // Handle the termination request
            await session.transport.handleRequest(req, res);

            // Clean up session
            sessions.delete(sessionId);
            logger.info(`🗑️  Session terminated: ${sessionId}`);

        } catch (error) {
            logger.error('❌ Error terminating session:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    // Handle HEAD requests to /mcp (for health checks)
    app.head('/mcp', (req, res) => {
        res.status(200).end();
    });

    // OAuth Discovery Endpoints - RFC 8414 and OpenID Connect Discovery compliant
    
    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment',
                    setup_required: 'Bind XSUAA service to this application'
                });
            }

            const xsuaaMetadata = authService.getXSUAADiscoveryMetadata()!;
            const appScopes = authService.getApplicationScopes();
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            
            const discoveryMetadata = {
                // Core OAuth 2.0 Authorization Server Metadata
                issuer: xsuaaMetadata.issuer,
                // authorization_endpoint: xsuaaMetadata.endpoints.authorization,
                // token_endpoint: xsuaaMetadata.endpoints.token,
                authorization_endpoint: "http://localhost:8080/oauth/authorize",//xsuaaMetadata.endpoints.authorization,
                token_endpoint: "http://localhost:8080/oauth/token",// xsuaaMetadata.endpoints.token,
                userinfo_endpoint: xsuaaMetadata.endpoints.userinfo,
                revocation_endpoint: xsuaaMetadata.endpoints.revocation,
                introspection_endpoint: xsuaaMetadata.endpoints.introspection,
                
                // Supported response types
                response_types_supported: [
                    'code',
                    // 'token',
                    // 'id_token',
                    // 'code token',
                    // 'code id_token',
                    // 'token id_token',
                    // 'code token id_token'
                ],
                
                // Supported grant types
                grant_types_supported: [
                    'authorization_code',
                    // 'refresh_token',
                    // 'client_credentials',
                    // 'urn:ietf:params:oauth:grant-type:jwt-bearer'
                ],
                
                // Supported scopes (XSUAA + application scopes)
                // scopes_supported: [
                //     'openid',
                //     'profile',
                //     'email',
                //     'uaa.user',
                //     'uaa.resource',
                //     ...appScopes
                // ],
                
                // Supported authentication methods
                // token_endpoint_auth_methods_supported: [
                //     'client_secret_basic',
                //     'client_secret_post',
                //     'private_key_jwt'
                // ],
                
                // Supported claim types and claims
                // claim_types_supported: ['normal'],
                // claims_supported: [
                //     'sub',
                //     'iss',
                //     'aud',
                //     'exp',
                //     'iat',
                //     'auth_time',
                //     'jti',
                //     'client_id',
                //     'scope',
                //     'zid',
                //     'origin',
                //     'user_name',
                //     'email',
                //     'given_name',
                //     'family_name',
                //     'phone_number'
                // ],
                
                // PKCE support
                code_challenge_methods_supported: ['S256'],
                
                // Service documentation
                service_documentation: `${baseUrl}/docs`,
                
                // Additional XSUAA specific metadata
                'x-xsuaa-metadata': {
                    xsappname: xsuaaMetadata.xsappname,
                    identityZone: xsuaaMetadata.identityZone,
                    tenantMode: xsuaaMetadata.tenantMode
                },
                
                // MCP-specific extensions
                'x-mcp-server': {
                    name: 'btp-sap-odata-to-mcp-server',
                    version: '2.0.0',
                    mcp_endpoint: `${baseUrl}/mcp`,
                    authentication_required: true,
                    capabilities: [
                        'SAP OData service discovery',
                        'CRUD operations with JWT forwarding',
                        'Dual authentication model',
                        'Session-based MCP transport',
                        'Scope-based authorization'
                    ]
                }
            };

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.json(discoveryMetadata);
        } catch (error) {
            logger.error('Failed to generate OAuth discovery metadata:', error);
            res.status(500).json({ 
                error: 'Failed to generate discovery metadata',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    // Custom OAuth metadata endpoint with MCP-specific information
    app.get('/oauth/.well-known/oauth_metadata', (req, res) => {
        try {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const xsuaaInfo = authService.getServiceInfo();
            const appScopes = authService.getApplicationScopes();
            
            if (!xsuaaInfo) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured',
                    setup_instructions: {
                        step1: 'Create XSUAA service instance in SAP BTP',
                        step2: 'Bind XSUAA service to this application',
                        step3: 'Configure xs-security.json with required scopes',
                        step4: 'Restart application to load XSUAA configuration'
                    }
                });
            }

            const metadata = {
                server: {
                    name: 'SAP BTP XSUAA OAuth Server via MCP',
                    version: '2.0.0',
                    description: 'OAuth 2.0 and OpenID Connect server for SAP OData MCP access',
                    provider: 'SAP BTP XSUAA Service'
                },
                
                xsuaa_service: {
                    url: xsuaaInfo.url,
                    xsappname: xsuaaInfo.xsappname,
                    identityZone: xsuaaInfo.identityZone,
                    tenantMode: xsuaaInfo.tenantMode,
                    configured: xsuaaInfo.configured
                },
                
                endpoints: {
                    // Local MCP server endpoints
                    authorization: `${baseUrl}/oauth/authorize`,
                    token_refresh: `${baseUrl}/oauth/refresh`,
                    userinfo: `${baseUrl}/oauth/userinfo`,
                    
                    // XSUAA service endpoints
                    xsuaa_authorization: `${xsuaaInfo.url}/oauth/authorize`,
                    xsuaa_token: `${xsuaaInfo.url}/oauth/token`,
                    xsuaa_userinfo: `${xsuaaInfo.url}/userinfo`,
                    xsuaa_jwks: `${xsuaaInfo.url}/token_keys`,
                    
                    // Discovery endpoints
                    oauth_discovery: `${baseUrl}/.well-known/oauth-authorization-server`,
                    openid_discovery: `${baseUrl}/.well-known/openid_configuration`
                },
                
                // application_scopes: appScopes,
                
                supported_features: [
                    'Authorization Code Flow'
                ],
                
                security: {
                    token_lifetime: 3600, // 1 hour
                    refresh_token_lifetime: 86400, // 24 hours
                    supported_algorithms: ['RS256'],
                    requires_https: process.env.NODE_ENV === 'production',
                    pkce_required: false
                },
                
                mcp_integration: {
                    mcp_server: `${baseUrl}/mcp`,
                    authentication_required: true,
                    dual_destinations: {
                        discovery: 'Technical user for service discovery',
                        execution: 'JWT token forwarding for data operations'
                    },
                    session_management: 'Automatic with user token context',
                    health_check: `${baseUrl}/health`,
                    documentation: `${baseUrl}/docs`
                },
                
                usage_instructions: {
                    step1: `Visit ${baseUrl}/oauth/authorize to initiate OAuth flow`,
                    step2: 'Login with SAP BTP credentials',
                    step3: 'Copy the access token from the callback response',
                    step4: `Use token in Authorization header for ${baseUrl}/mcp requests`
                }
            };

            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes
            res.json(metadata);
        } catch (error) {
            logger.error('Failed to generate OAuth metadata:', error);
            res.status(500).json({ 
                error: 'Failed to generate OAuth metadata',
                message: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    });

    // OAuth endpoints for XSUAA authentication
    app.get('/oauth/authorize', (req, res) => {
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment'
                });
            }

            const state = req.query.state as string || randomUUID();
            const authUrl = authService.getAuthorizationUrl(state);
            res.redirect(authUrl);
        } catch (error) {
            logger.error('Failed to initiate OAuth flow:', error);
            res.status(500).json({ error: 'Failed to initiate OAuth flow' });
        }
    });

    // OAuth proxy for MCP Inspector - handles the OAuth flow translation
    app.get('/oauth/mcp-inspector/authorize', (req, res) => {
        try {
            if (!authService.isConfigured()) {
                return res.status(501).json({
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment'
                });
            }

            // Store MCP Inspector's redirect_uri and state for later use
            const mcpRedirectUri = req.query.redirect_uri as string;
            const mcpState = req.query.state as string;
            const mcpCodeChallenge = req.query.code_challenge as string;
            const mcpCodeChallengeMethod = req.query.code_challenge_method as string;
            
            if (!mcpRedirectUri) {
                return res.status(400).json({ 
                    error: 'Missing redirect_uri parameter',
                    message: 'MCP Inspector redirect URI is required'
                });
            }
            
            // Store MCP Inspector's callback info in session/memory
            const proxyState = randomUUID();
            
            // Store mapping in a simple in-memory store (you might want to use Redis in production)
            if (!(global as any).mcpProxyStates) {
                (global as any).mcpProxyStates = new Map();
            }
            (global as any).mcpProxyStates.set(proxyState, {
                mcpRedirectUri,
                mcpState,
                mcpCodeChallenge,
                mcpCodeChallengeMethod,
                timestamp: Date.now()
            });
            
            // Clean up old states (older than 10 minutes)
            for (const [key, value] of (global as any).mcpProxyStates.entries()) {
                if (Date.now() - value.timestamp > 600000) {
                    (global as any).mcpProxyStates.delete(key);
                }
            }
            
            logger.info(`MCP Inspector OAuth proxy initiated for redirect: ${mcpRedirectUri}`);
            
            // Redirect to our regular OAuth authorize with proxy state
            const authUrl = authService.getAuthorizationUrl(proxyState);
            res.redirect(authUrl);
        } catch (error) {
            logger.error('MCP Inspector OAuth proxy error:', error);
            res.status(500).json({
                error: 'OAuth Proxy Failed',
                message: error instanceof Error ? error.message : 'Failed to initialize MCP Inspector OAuth proxy'
            });
        }
    });

    // OAuth callback endpoint - Enhanced with HTML response option and MCP Inspector proxy support
    app.get('/oauth/callback', async (req, res) => {
        try {
            const code = req.query.code as string;
            const state = req.query.state as string;
            const format = req.query.format as string || 'html'; // Default to HTML for better UX
            const acceptHeader = req.headers.accept || '';
            const error = req.query.error as string;
            
            if (error) {
                const errorMsg = req.query.error_description as string || error;
                if (format === 'json' || acceptHeader.includes('application/json')) {
                    return res.status(400).json({ 
                        error: 'OAuth Authorization Failed',
                        message: errorMsg,
                        details: 'XSUAA authorization was denied or failed'
                    });
                } else {
                    return res.status(400).send(`
                        <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                            <h1>❌ Authentication Failed</h1>
                            <p>${errorMsg}</p>
                            <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                        </body></html>
                    `);
                }
            }
            
            if (!code) {
                if (format === 'json' || acceptHeader.includes('application/json')) {
                    return res.status(400).json({ error: 'Authorization code not provided' });
                } else {
                    return res.status(400).send(`
                        <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                            <h1>❌ Authentication Failed</h1>
                            <p>Authorization code not provided.</p>
                            <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                        </body></html>
                    `);
                }
            }

            // Check if this is a MCP Inspector proxy callback
            const mcpProxyStates = (global as any).mcpProxyStates;
            const mcpInfo = state && mcpProxyStates?.get(state);
            
            if (mcpInfo) {
                // This is an MCP Inspector proxy callback
                try {
                    // Exchange code for token with XSUAA using our server's redirect URI 
                    // (the same one used in the authorization request)
                    const tokenResult = await authService.exchangeCodeForToken(code, authService.getRedirectUri());
                    
                    // Clean up the proxy state
                    mcpProxyStates.delete(state);
                    
                    // Construct the response for MCP Inspector
                    const callbackUrl = new URL(mcpInfo.mcpRedirectUri);
                    
                    // Use fragment-based response (implicit flow style) for better compatibility
                    callbackUrl.hash = new URLSearchParams({
                        access_token: tokenResult.accessToken,
                        token_type: 'Bearer',
                        expires_in: tokenResult.expiresIn.toString(),
                        state: mcpInfo.mcpState || '',
                        ...(tokenResult.refreshToken && { refresh_token: tokenResult.refreshToken })
                    }).toString();
                    
                    logger.info(`MCP Inspector OAuth proxy successful, redirecting to: ${mcpInfo.mcpRedirectUri}`);
                    return res.redirect(callbackUrl.toString());
                    
                } catch (error) {
                    logger.error('MCP Inspector OAuth token exchange failed:', error);
                    
                    // Redirect back to MCP Inspector with error
                    const errorUrl = new URL(mcpInfo.mcpRedirectUri);
                    errorUrl.hash = new URLSearchParams({
                        error: 'server_error',
                        error_description: error instanceof Error ? error.message : 'Token exchange failed',
                        state: mcpInfo.mcpState || ''
                    }).toString();
                    
                    mcpProxyStates.delete(state);
                    return res.redirect(errorUrl.toString());
                }
            }

            // Regular OAuth callback (not MCP Inspector proxy)
            const tokenData = await authService.exchangeCodeForToken(code);
            
            // Determine response format
            if (format === 'json' || acceptHeader.includes('application/json')) {
                // JSON response for API clients
                res.json({
                    accessToken: tokenData.accessToken,
                    refreshToken: tokenData.refreshToken,
                    expiresIn: tokenData.expiresIn,
                    message: 'Authentication successful. Use the access token in the Authorization header for API calls.'
                });
            } else {
                // HTML response for browser-based flow (default)
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                const expiryTime = new Date(Date.now() + tokenData.expiresIn * 1000);
                
                res.send(`
                            <html>
                            <head><title>SAP MCP Authentication Success</title></head>
                            <body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                                <h1>✅ Authentication Successful!</h1>
                                <p>Your access token:</p>
                                <div style="background: #f8f9fa; padding: 1rem; border-radius: 4px; word-break: break-all; margin: 1rem 0;">
                                    <code>${tokenData.accessToken}</code>
                                </div>
                                <p>Token expires in: ${Math.floor(tokenData.expiresIn / 60)} minutes</p>
                                <div style="margin-top: 2rem;">
                                    <button onclick="navigator.clipboard.writeText('${tokenData.accessToken}'); alert('Token copied!')" 
                                            style="padding: 0.5rem 1rem; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">📋 Copy Token</button>
                                    <a href="/oauth/inspector?token=${encodeURIComponent(tokenData.accessToken)}" 
                                       style="display: inline-block; margin-left: 0.5rem; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">🚀 Launch MCP Inspector</a>
                                </div>
                                <script>
                                    // Store token data for immediate use
                                    window.tokenData = ${JSON.stringify(tokenData)};
                                    window.baseUrl = '${baseUrl}';
                                </script>
                            </body>
                            </html>
                        `);
            }
        } catch (error) {
            logger.error('OAuth callback failed:', error);
            
            if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
                res.status(500).json({ 
                    error: 'Authentication failed',
                    details: error instanceof Error ? error.message : 'Unknown error'
                });
            } else {
                res.status(500).send(`
                    <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                        <h1>❌ Authentication Failed</h1>
                        <p>Error: ${error instanceof Error ? error.message : 'Unknown error'}</p>
                        <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Try Again</a>
                    </body></html>
                `);
            }
        }
    });

    // Token refresh endpoint
    app.post('/oauth/refresh', async (req, res) => {
        try {
            const { refreshToken } = req.body;
            if (!refreshToken) {
                return res.status(400).json({ error: 'Refresh token not provided' });
            }

            const tokenData = await authService.refreshAccessToken(refreshToken);
            res.json({
                accessToken: tokenData.accessToken,
                expiresIn: tokenData.expiresIn
            });
        } catch (error) {
            logger.error('Token refresh failed:', error);
            res.status(401).json({ error: 'Token refresh failed' });
        }
    });

    // User info endpoint
    app.get('/oauth/userinfo', authService.authenticateJWT() as express.RequestHandler, (req, res) => {
        const authReq = req as AuthRequest;
        if (!authReq.authInfo) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userInfo = authService.getUserInfo(authReq.authInfo);
        res.json(userInfo);
    });

    // MCP Inspector Integration endpoint
    app.get('/oauth/inspector', async (req, res) => {
        try {
            const token = req.query.token as string;
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            
            if (!token) {
                return res.status(400).send(`
                    <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                        <h1>❌ Token Required</h1>
                        <p>No authentication token provided for MCP Inspector launch.</p>
                        <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Get Token</a>
                    </body></html>
                `);
            }

            // Validate token first
            let userInfo = null;
            try {
                const response = await fetch(`${baseUrl}/oauth/userinfo`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (response.ok) {
                    userInfo = await response.json();
                }
            } catch (error) {
                logger.debug('Token validation failed for inspector launch:', error);
            }

            // Generate MCP Inspector launch page
            res.send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Launch MCP Inspector - SAP OData</title>
                    <style>
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            margin: 0;
                            color: #333;
                        }
                        .container {
                            background: white;
                            border-radius: 20px;
                            padding: 2rem;
                            max-width: 600px;
                            width: 90%;
                            text-align: center;
                            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                        }
                        .success-icon { font-size: 3rem; color: #28a745; margin-bottom: 1rem; }
                        h1 { color: #2c3e50; margin-bottom: 1rem; }
                        .user-info {
                            background: #f8f9fa;
                            border-radius: 8px;
                            padding: 1rem;
                            margin: 1rem 0;
                            border-left: 4px solid #007bff;
                        }
                        .instructions {
                            background: #e3f2fd;
                            border-radius: 8px;
                            padding: 1.5rem;
                            margin: 1.5rem 0;
                            text-align: left;
                        }
                        .command-box {
                            background: #2d3748;
                            color: #e2e8f0;
                            padding: 1rem;
                            border-radius: 8px;
                            font-family: 'Monaco', monospace;
                            font-size: 0.9rem;
                            margin: 1rem 0;
                            word-break: break-all;
                        }
                        .btn {
                            display: inline-block;
                            padding: 0.75rem 1.5rem;
                            margin: 0.5rem;
                            background: #007bff;
                            color: white;
                            text-decoration: none;
                            border-radius: 8px;
                            border: none;
                            cursor: pointer;
                            font-size: 1rem;
                            transition: all 0.2s ease;
                        }
                        .btn:hover {
                            background: #0056b3;
                            transform: translateY(-2px);
                        }
                        .btn-copy { background: #28a745; }
                        .btn-copy:hover { background: #1e7e34; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="success-icon">🚀</div>
                        <h1>Launch MCP Inspector</h1>
                        
                        ${userInfo ? `
                            <div class="user-info">
                                <strong>Authenticated as:</strong> ${userInfo.username}<br>
                                <small>Email: ${userInfo.email || 'Not provided'}</small>
                            </div>
                        ` : ''}
                        
                        <div class="instructions">
                            <h3>Option 1: Automatic Launch (Recommended)</h3>
                            <p>Click the button below to automatically launch MCP Inspector with authentication:</p>
                            <button onclick="launchInspector()" class="btn">🚀 Launch MCP Inspector Now</button>
                        </div>
                        
                        <div class="instructions">
                            <h3>Option 2: Manual Setup</h3>
                            <p>1. Run this command in your terminal:</p>
                            <div class="command-box" id="inspectorCommand">
                                npx @modelcontextprotocol/inspector
                            </div>
                            <button onclick="copyCommand()" class="btn btn-copy">📋 Copy Command</button>
                            
                            <p>2. In MCP Inspector, configure:</p>
                            <ul style="text-align: left;">
                                <li><strong>Server URL:</strong> ${baseUrl}/mcp</li>
                                <li><strong>Header:</strong> Authorization: Bearer [token]</li>
                            </ul>
                            
                            <p>3. Your authentication token:</p>
                            <div class="command-box" id="authToken" style="font-size: 0.8rem;">
                                ${token.substring(0, 50)}...
                            </div>
                            <button onclick="copyToken()" class="btn btn-copy">📋 Copy Full Token</button>
                        </div>
                        
                        <div class="instructions">
                            <h3>Option 3: Direct Command Line</h3>
                            <p>Use this command to launch with pre-configured authentication:</p>
                            <div class="command-box" id="directCommand">
                                npx @modelcontextprotocol/inspector "${baseUrl}/mcp" --header "Authorization: Bearer ${token}"
                            </div>
                            <button onclick="copyDirectCommand()" class="btn btn-copy">📋 Copy Direct Command</button>
                        </div>
                        
                        <p style="color: #6c757d; font-size: 0.9rem; margin-top: 2rem;">
                            <strong>Note:</strong> Your token expires in ~1 hour. 
                            <a href="/oauth/authorize" style="color: #007bff;">Re-authenticate</a> when needed.
                        </p>
                    </div>
                    
                    <script>
                        const token = '${token}';
                        const baseUrl = '${baseUrl}';
                        
                        function launchInspector() {
                            // Try different methods to launch MCP Inspector
                            
                            // Method 1: Try to open a custom protocol handler
                            const mcpUrl = \`mcp://${baseUrl.replace('http://', '').replace('https://', '')}/mcp?auth=\${encodeURIComponent(token)}\`;
                            window.location.href = mcpUrl;
                            
                            // Method 2: Show instructions after a delay
                            setTimeout(() => {
                                alert('If MCP Inspector did not launch automatically, please use the manual setup instructions below.');
                            }, 2000);
                        }
                        
                        function copyCommand() {
                            navigator.clipboard.writeText('npx @modelcontextprotocol/inspector').then(() => {
                                alert('📋 Command copied to clipboard!');
                            });
                        }
                        
                        function copyToken() {
                            navigator.clipboard.writeText(token).then(() => {
                                alert('📋 Full token copied to clipboard!');
                            });
                        }
                        
                        function copyDirectCommand() {
                            const command = \`npx @modelcontextprotocol/inspector "\${baseUrl}/mcp" --header "Authorization: Bearer \${token}"\`;
                            navigator.clipboard.writeText(command).then(() => {
                                alert('📋 Direct command copied to clipboard!');
                            });
                        }
                    </script>
                </body>
                </html>
            `);
        } catch (error) {
            logger.error('MCP Inspector launch failed:', error);
            res.status(500).send(`
                <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                    <h1>❌ Launch Failed</h1>
                    <p>Error preparing MCP Inspector launch: ${error instanceof Error ? error.message : 'Unknown error'}</p>
                    <a href="/oauth/authorize" style="display: inline-block; padding: 0.5rem 1rem; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">Start Over</a>
                </body></html>
            `);
        }
    });

    // OAuth status and management endpoint
    app.get('/oauth/status', async (req, res) => {
        try {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const format = req.query.format as string || 'html';
            const token = req.query.token as string || req.headers.authorization?.replace('Bearer ', '');
            
            if (!authService.isConfigured()) {
                const errorResponse = {
                    error: 'OAuth not configured',
                    message: 'XSUAA service is not configured for this deployment',
                    setup_required: 'Bind XSUAA service to this application'
                };
                
                if (format === 'json' || req.headers.accept?.includes('application/json')) {
                    return res.status(501).json(errorResponse);
                } else {
                    return res.status(501).send(`
                        <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                            <h1>❌ OAuth Not Configured</h1>
                            <p>${errorResponse.message}</p>
                            <p><strong>Setup Required:</strong> ${errorResponse.setup_required}</p>
                        </body></html>
                    `);
                }
            }
            
            // Create integration status
            const oauthIntegrationService = new OAuthIntegrationService(authService, logger);
            const integrationStatus = await oauthIntegrationService.createIntegrationStatus(baseUrl, token);
            
            if (format === 'json' || req.headers.accept?.includes('application/json')) {
                res.json(integrationStatus);
            } else {
                // Generate HTML dashboard
                const tokenStatus = 'token_status' in integrationStatus ? integrationStatus.token_status : undefined;
                const tokenDisplay = token && tokenStatus ? oauthIntegrationService.generateTokenDisplayHTML(token, tokenStatus, baseUrl) : '';
                const connectionInstructions = 'connection_instructions' in integrationStatus ? integrationStatus.connection_instructions : {};
                
                res.send(`
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>OAuth Status - SAP MCP Server</title>
                        <style>
                            * { margin: 0; padding: 0; box-sizing: border-box; }
                            body {
                                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                min-height: 100vh;
                                padding: 2rem;
                                color: #333;
                            }
                            .container {
                                max-width: 1000px;
                                margin: 0 auto;
                                background: white;
                                border-radius: 20px;
                                padding: 2rem;
                                box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                            }
                            .header {
                                text-align: center;
                                margin-bottom: 2rem;
                                padding-bottom: 1rem;
                                border-bottom: 2px solid #e9ecef;
                            }
                            .status-grid {
                                display: grid;
                                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                                gap: 2rem;
                                margin-bottom: 2rem;
                            }
                            .status-card {
                                background: #f8f9fa;
                                border-radius: 10px;
                                padding: 1.5rem;
                                border-left: 4px solid #007bff;
                            }
                            .status-card.success { border-left-color: #28a745; }
                            .status-card.warning { border-left-color: #ffc107; }
                            .status-card.error { border-left-color: #dc3545; }
                            .status-card h3 {
                                color: #2c3e50;
                                margin-bottom: 1rem;
                                display: flex;
                                align-items: center;
                                gap: 0.5rem;
                            }
                            .btn {
                                display: inline-block;
                                padding: 0.75rem 1.5rem;
                                margin: 0.5rem;
                                border: none;
                                border-radius: 8px;
                                font-size: 1rem;
                                font-weight: 500;
                                text-decoration: none;
                                cursor: pointer;
                                transition: all 0.2s ease;
                            }
                            .btn-primary { background: #007bff; color: white; }
                            .btn-success { background: #28a745; color: white; }
                            .btn-secondary { background: #6c757d; color: white; }
                            .btn-copy { background: #17a2b8; color: white; }
                            .btn:hover { transform: translateY(-2px); opacity: 0.9; }
                            .token-section { background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 10px; padding: 1.5rem; margin: 1rem 0; }
                            .token-status.valid { color: #28a745; font-weight: bold; }
                            .token-status.invalid { color: #dc3545; font-weight: bold; }
                            .code-block {
                                background: #f8f9fa;
                                border: 1px solid #dee2e6;
                                border-radius: 5px;
                                padding: 0.75rem;
                                font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                                font-size: 0.875rem;
                                margin: 0.5rem 0;
                                overflow-x: auto;
                            }
                            .instructions-section {
                                background: #e3f2fd;
                                border-radius: 10px;
                                padding: 1.5rem;
                                margin: 2rem 0;
                            }
                            .instructions-section h3 { color: #1976d2; margin-bottom: 1rem; }
                            .instructions-section ol { margin-left: 1.5rem; }
                            .instructions-section li { margin-bottom: 0.5rem; line-height: 1.6; }
                            .endpoint-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
                            .endpoint { background: white; border: 1px solid #dee2e6; border-radius: 5px; padding: 1rem; }
                            .endpoint strong { color: #495057; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <h1>🔐 OAuth Status Dashboard</h1>
                                <p>SAP BTP XSUAA Authentication for MCP Server</p>
                            </div>
                            
                            <div class="status-grid">
                                <div class="status-card ${integrationStatus.oauth_configured ? 'success' : 'error'}">
                                    <h3>${integrationStatus.oauth_configured ? '✅' : '❌'} OAuth Configuration</h3>
                                    <p>${integrationStatus.oauth_configured ? 'XSUAA service is properly configured' : 'XSUAA service not configured - bind XSUAA service to enable OAuth'}</p>
                                </div>
                                
                                <div class="status-card ${integrationStatus.authentication.current_status === 'token_provided' ? 'success' : 'warning'}">
                                    <h3>🔑 Authentication Status</h3>
                                    <p><strong>Status:</strong> ${integrationStatus.authentication.current_status}</p>
                                    <p><strong>Required:</strong> ${integrationStatus.authentication.required ? 'Yes' : 'No'}</p>
                                    ${!token ? '<a href="/oauth/authorize" class="btn btn-primary">🚀 Get Token</a>' : ''}
                                </div>
                                
                                <div class="status-card ${'integration_ready' in integrationStatus && integrationStatus.integration_ready ? 'success' : 'warning'}">
                                    <h3>🔗 MCP Integration</h3>
                                    <p><strong>Ready:</strong> ${'integration_ready' in integrationStatus && integrationStatus.integration_ready ? 'Yes' : 'No'}</p>
                                    <p><strong>Server:</strong> ${integrationStatus.mcp_integration.server_url}</p>
                                    <p><strong>Auth:</strong> ${integrationStatus.mcp_integration.authentication_method}</p>
                                </div>
                            </div>
                            
                            ${tokenDisplay}
                            
                            <div class="instructions-section">
                                <h3>📋 MCP Client Setup Instructions</h3>
                                
                                ${Object.entries(connectionInstructions).map(([clientKey, clientInfo]: [string, any]) => `
                                    <div class="endpoint" style="margin-bottom: 1rem;">
                                        <h4>${clientInfo.title}</h4>
                                        <p>${clientInfo.description}</p>
                                        <ol>
                                            ${clientInfo.steps.map((step: string) => `<li>${step}</li>`).join('')}
                                        </ol>
                                        ${clientInfo.directCommand ? `<div class="code-block">${clientInfo.directCommand}</div>` : ''}
                                    </div>
                                `).join('')}
                            </div>
                            
                            <div class="status-card">
                                <h3>🔗 Available Endpoints</h3>
                                <div class="endpoint-list">
                                    ${Object.entries(integrationStatus.endpoints).map(([key, url]) => `
                                        <div class="endpoint">
                                            <strong>${key}:</strong><br>
                                            <a href="${url}" target="_blank">${url}</a>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                            
                            <div style="text-align: center; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #dee2e6;">
                                <button onclick="refreshPage()" class="btn btn-secondary">🔄 Refresh Status</button>
                                <button onclick="copyStatusJson()" class="btn btn-copy">📋 Copy JSON Status</button>
                                <a href="${baseUrl}/docs" class="btn btn-secondary">📚 API Documentation</a>
                            </div>
                        </div>
                        
                        <script>
                            function copyToken(token) {
                                navigator.clipboard.writeText(token).then(() => {
                                    showMessage('Token copied to clipboard!', 'success');
                                });
                            }
                            
                            function refreshPage() {
                                window.location.reload();
                            }
                            
                            function copyStatusJson() {
                                fetch('${baseUrl}/oauth/status?format=json')
                                    .then(response => response.json())
                                    .then(data => {
                                        navigator.clipboard.writeText(JSON.stringify(data, null, 2));
                                        showMessage('JSON status copied to clipboard!', 'success');
                                    })
                                    .catch(error => showMessage('Failed to copy JSON status', 'error'));
                            }
                            
                            function showMessage(message, type) {
                                const alertDiv = document.createElement('div');
                                alertDiv.style.cssText = \`
                                    position: fixed; top: 20px; right: 20px; z-index: 1000;
                                    padding: 1rem; border-radius: 5px; font-weight: 500;
                                    background: \${type === 'success' ? '#28a745' : '#dc3545'};
                                    color: white; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                                \`;
                                alertDiv.textContent = message;
                                document.body.appendChild(alertDiv);
                                
                                setTimeout(() => {
                                    alertDiv.remove();
                                }, 3000);
                            }
                        </script>
                    </body>
                    </html>
                `);
            }
            
        } catch (error) {
            logger.error('Error generating OAuth status:', error);
            
            const errorResponse = {
                error: 'Status generation failed',
                message: error instanceof Error ? error.message : 'Unknown error'
            };
            
            if (req.query.format === 'json' || req.headers.accept?.includes('application/json')) {
                res.status(500).json(errorResponse);
            } else {
                res.status(500).send(`
                    <html><body style="font-family: sans-serif; text-align: center; padding: 2rem;">
                        <h1>❌ Status Generation Failed</h1>
                        <p>Error: ${errorResponse.message}</p>
                        <a href="/oauth/authorize" class="btn btn-primary">Try Authentication</a>
                    </body></html>
                `);
            }
        }
    });

    // API documentation endpoint
    app.get('/docs', (req, res) => {
        res.json({
            title: 'SAP MCP Server API',
            description: 'Modern Model Context Protocol server for SAP SAP OData services',
            version: '2.0.0',
            endpoints: {
                'GET /health': 'Health check endpoint',
                'GET /mcp': 'MCP server information and SSE endpoint',
                'POST /mcp': 'Main MCP communication endpoint',
                'DELETE /mcp': 'Session termination endpoint',
                'GET /docs': 'This API documentation',
                'GET /.well-known/oauth-authorization-server': 'OAuth 2.0 Authorization Server Metadata (RFC 8414)',
                'GET /.well-known/openid_configuration': 'OpenID Connect Discovery Configuration',
                'GET /oauth/.well-known/oauth_metadata': 'Custom OAuth metadata with MCP integration info',
                'GET /oauth/authorize': 'Initiate OAuth authorization flow',
                'GET /oauth/callback': 'OAuth authorization callback',
                'POST /oauth/refresh': 'Refresh access tokens',
                'GET /oauth/userinfo': 'Get authenticated user information'
            },
            mcpCapabilities: {
                tools: 'Dynamic CRUD operations for all discovered SAP entities',
                resources: 'Service metadata and entity information',
                logging: 'Comprehensive logging support'
            },
            usage: {
                exampleQueries: [
                    '"Find all sales-related services"',
                    '"Show me what entities are available in the flight booking service"',
                    '"Read the top 10 customers from the business partner service"',
                    '"Create a new travel booking with passenger details"',
                    '"Update the status of order 12345 to completed"',
                    '"Delete the cancelled reservation with ID 67890"'
                ],
                workflowSteps: [
                    'Authentication: Get OAuth token via browser or API',
                    'Discovery: Search services and explore entities',
                    'Execution: Perform CRUD operations with user context',
                    'Monitoring: Check logs and session status'
                ],
                authentication: 'OAuth 2.0 with SAP XSUAA - JWT tokens required for data operations',
                sessionManagement: 'Automatic session creation with user token context'
            }
        });
    });

    // Service discovery configuration endpoints
    app.get('/config/services', (req, res) => {
        try {
            const configSummary = serviceConfigService.getConfigurationSummary();
            res.json(configSummary);
        } catch (error) {
            logger.error('Failed to get service configuration:', error);
            res.status(500).json({ error: 'Failed to get service configuration' });
        }
    });

    // Test service patterns endpoint
    app.post('/config/services/test', (req, res) => {
        try {
            const { serviceNames } = req.body;

            if (!Array.isArray(serviceNames)) {
                return res.status(400).json({ error: 'serviceNames must be an array of strings' });
            }

            const testResult = serviceConfigService.testPatterns(serviceNames);
            res.json(testResult);
        } catch (error) {
            logger.error('Failed to test service patterns:', error);
            res.status(500).json({ error: 'Failed to test service patterns' });
        }
    });

    // Update service configuration endpoint
    app.post('/config/services/update', (req, res) => {
        try {
            const newConfig = req.body;
            serviceConfigService.updateConfiguration(newConfig);

            const updatedConfig = serviceConfigService.getConfigurationSummary();
            res.json({
                message: 'Configuration updated successfully',
                configuration: updatedConfig
            });
        } catch (error) {
            logger.error('Failed to update service configuration:', error);
            res.status(500).json({ error: 'Failed to update service configuration' });
        }
    });
    // Handle 404s
    app.use((req, res) => {
        logger.warn(`❌ 404 - Not found: ${req.method} ${req.path}`);
        res.status(404).json({
            error: 'Not Found',
            message: `The requested endpoint ${req.method} ${req.path} was not found`,
            availableEndpoints: ['/health', '/mcp', '/docs']
        });
    });

    // Global error handler
    app.use((error: Error, req: express.Request, res: express.Response) => {
        logger.error('❌ Unhandled error:', error);

        if (!res.headersSent) {
            res.status(500).json({
                error: 'Internal Server Error',
                message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
            });
        }
    });

    // Clean up expired sessions every hour
    setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

    return app;
}

/**
 * Start the server
 */
export async function startServer(port: number = 3000): Promise<void> {
    const app = createApp();

    return new Promise((resolve, reject) => {
        try {
            const server = app.listen(port, async () => {
                logger.info(`🚀 SAP MCP Server running at http://localhost:${port}`);
                logger.info(`📊 Health check: http://localhost:${port}/health`);
                logger.info(`📚 API docs: http://localhost:${port}/docs`);
                logger.info(`🔧 MCP endpoint: http://localhost:${port}/mcp`);

                logger.info('🚀 Initializing Modern SAP MCP Server...');

                // Initialize destination service
                await destinationService.initialize();

                // Discover SAP OData services
                logger.info('🔍 Discovering SAP OData services...');
                discoveredServices = await sapDiscoveryService.discoverAllServices();

                logger.info(`✅ Discovered ${discoveredServices.length} OData services`);
                resolve();
            });

            server.on('error', (error) => {
                logger.error(`❌ Server error:`, error);
                reject(error);
            });

            // Graceful shutdown
            process.on('SIGTERM', () => {
                logger.info('🛑 SIGTERM received, shutting down gracefully...');

                // Close all sessions
                for (const [sessionId, session] of sessions.entries()) {
                    logger.info(`🔌 Closing session: ${sessionId}`);
                    session.transport.close();
                }
                sessions.clear();

                server.close(() => {
                    logger.info('✅ Server shut down successfully');
                    process.exit(0);
                });
            });

        } catch (error) {
            logger.error(`❌ Failed to start server:`, error);
            reject(error);
        }
    });
}

// Start server if this file is run directly
const port = parseInt(process.env.PORT || '3000');
startServer(port).catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
