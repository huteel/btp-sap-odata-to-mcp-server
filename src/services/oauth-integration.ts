import { Logger } from '../utils/logger.js';
import { AuthService } from './auth-service.js';

export interface MCPInspectorConfig {
    serverUrl: string;
    authToken: string;
    userInfo?: {
        username: string;
        email: string;
        scopes: string[];
    };
}

export interface TokenStatus {
    valid: boolean;
    expiresAt?: Date;
    expiresIn?: number;
    userInfo?: {
        username: string;
        email: string;
        scopes: string[];
    };
    error?: string;
}

export class OAuthIntegrationService {
    private logger: Logger;
    private authService: AuthService;

    constructor(authService: AuthService, logger?: Logger) {
        this.authService = authService;
        this.logger = logger || new Logger('OAuthIntegrationService');
    }

    /**
     * Generate MCP Inspector configuration with authentication
     */
    async generateMCPInspectorConfig(baseUrl: string, token: string): Promise<MCPInspectorConfig> {
        const config: MCPInspectorConfig = {
            serverUrl: `${baseUrl}/mcp`,
            authToken: token
        };

        try {
            // Validate token and get user info
            const securityContext = await this.authService.validateToken(token);
            config.userInfo = this.authService.getUserInfo(securityContext);
        } catch (error) {
            this.logger.debug('Token validation failed for MCP Inspector config:', error);
            // Still return config even if token validation fails
        }

        return config;
    }

    /**
     * Generate various launch commands for MCP Inspector
     */
    generateMCPInspectorCommands(baseUrl: string, token: string) {
        const serverUrl = `${baseUrl}/mcp`;
        const authHeader = `Authorization: Bearer ${token}`;

        return {
            basic: 'npx @modelcontextprotocol/inspector',
            withUrl: `npx @modelcontextprotocol/inspector "${serverUrl}"`,
            withAuth: `npx @modelcontextprotocol/inspector "${serverUrl}" --header "${authHeader}"`,
            environment: {
                command: 'npx @modelcontextprotocol/inspector',
                envVars: {
                    MCP_SERVER_URL: serverUrl,
                    AUTHORIZATION_HEADER: authHeader
                }
            }
        };
    }

    /**
     * Check token status and validity
     */
    async checkTokenStatus(token: string): Promise<TokenStatus> {
        try {
            const securityContext = await this.authService.validateToken(token);
            const userInfo = this.authService.getUserInfo(securityContext);
            
            // Extract expiration from token if available
            const expirationDate = securityContext.getExpirationDate();
            const now = new Date();
            const expiresIn = expirationDate ? Math.max(0, Math.floor((expirationDate.getTime() - now.getTime()) / 1000)) : undefined;

            return {
                valid: true,
                expiresAt: expirationDate || undefined,
                expiresIn,
                userInfo
            };
        } catch (error) {
            return {
                valid: false,
                error: error instanceof Error ? error.message : 'Token validation failed'
            };
        }
    }

    /**
     * Generate deep link URLs for various integrations
     */
    generateDeepLinks(baseUrl: string, token: string) {
        const serverUrl = `${baseUrl}/mcp`;
        
        return {
            // Custom MCP protocol (if supported)
            mcp: `mcp://${serverUrl.replace('http://', '').replace('https://', '')}?auth=${encodeURIComponent(token)}`,
            
            // VS Code extension deep link (if available)
            vscode: `vscode://mcp-extension.connect?url=${encodeURIComponent(serverUrl)}&auth=${encodeURIComponent(token)}`,
            
            // Generic application launch
            inspector: `${baseUrl}/oauth/inspector?token=${encodeURIComponent(token)}`,
            
            // Direct callback with token
            callback: `${baseUrl}/oauth/callback?token=${encodeURIComponent(token)}&format=html`
        };
    }

    /**
     * Generate HTML for token display and management
     */
    generateTokenDisplayHTML(token: string, tokenStatus: TokenStatus, baseUrl: string): string {
        const expiryText = tokenStatus.expiresIn 
            ? `Expires in ${Math.floor(tokenStatus.expiresIn / 60)} minutes`
            : 'Expiration unknown';

        return `
            <div class="token-section">
                <h3>🔑 Authentication Token</h3>
                <div class="token-status ${tokenStatus.valid ? 'valid' : 'invalid'}">
                    ${tokenStatus.valid ? '✅ Valid' : '❌ Invalid'} - ${expiryText}
                </div>
                
                ${tokenStatus.userInfo ? `
                    <div class="user-info">
                        <strong>User:</strong> ${tokenStatus.userInfo.username}<br>
                        <strong>Email:</strong> ${tokenStatus.userInfo.email || 'Not provided'}<br>
                        <strong>Scopes:</strong> ${tokenStatus.userInfo.scopes.join(', ') || 'None'}
                    </div>
                ` : ''}
                
                <div class="token-display">
                    ${token.substring(0, 50)}...
                </div>
                
                <div class="token-actions">
                    <button onclick="copyToken('${token}')" class="btn btn-copy">📋 Copy Token</button>
                    <a href="${baseUrl}/oauth/inspector?token=${encodeURIComponent(token)}" class="btn btn-primary">🚀 Launch Inspector</a>
                    ${!tokenStatus.valid ? `<a href="${baseUrl}/oauth/authorize" class="btn btn-secondary">🔄 Re-authenticate</a>` : ''}
                </div>
            </div>
        `;
    }

    /**
     * Generate connection instructions for different MCP clients
     */
    generateConnectionInstructions(baseUrl: string, token: string) {
        const commands = this.generateMCPInspectorCommands(baseUrl, token);
        
        return {
            mcpInspector: {
                title: 'MCP Inspector',
                description: 'Official MCP debugging and exploration tool',
                steps: [
                    `Run: ${commands.basic}`,
                    `Enter Server URL: ${baseUrl}/mcp`,
                    `Add Header: Authorization: Bearer [your-token]`,
                    'Click "Connect" to explore SAP data'
                ],
                directCommand: commands.withAuth
            },
            
            vscode: {
                title: 'VS Code with MCP Extension',
                description: 'Use MCP within VS Code editor',
                steps: [
                    'Install MCP extension for VS Code',
                    'Open command palette (Cmd/Ctrl + Shift + P)',
                    'Run "MCP: Connect to Server"',
                    `Enter server URL: ${baseUrl}/mcp`,
                    'Configure authentication header'
                ]
            },
            
            claude: {
                title: 'Claude Desktop',
                description: 'Use with Claude Desktop application',
                steps: [
                    'Open Claude Desktop settings',
                    'Add MCP server configuration:',
                    `  Server: ${baseUrl}/mcp`,
                    '  Headers: Authorization: Bearer [token]',
                    'Restart Claude Desktop'
                ]
            },
            
            api: {
                title: 'Direct API Access',
                description: 'Use MCP protocol directly via HTTP',
                steps: [
                    'Send POST requests to /mcp endpoint',
                    'Include Authorization header with Bearer token',
                    'Use MCP JSON-RPC 2.0 protocol format',
                    'See MCP specification for message format'
                ]
            }
        };
    }

    /**
     * Create comprehensive OAuth integration status
     */
    async createIntegrationStatus(baseUrl: string, token?: string) {
        const status = {
            oauth_configured: this.authService.isConfigured(),
            authentication: {
                required: true,
                current_status: token ? 'token_provided' : 'no_token'
            },
            endpoints: {
                authorize: `${baseUrl}/oauth/authorize`,
                callback: `${baseUrl}/oauth/callback`,
                userinfo: `${baseUrl}/oauth/userinfo`,
                inspector: `${baseUrl}/oauth/inspector`,
                status: `${baseUrl}/oauth/status`
            },
            mcp_integration: {
                server_url: `${baseUrl}/mcp`,
                authentication_method: 'Bearer token in Authorization header',
                supported_clients: ['MCP Inspector', 'VS Code', 'Claude Desktop', 'Direct API']
            }
        };

        if (token) {
            const tokenStatus = await this.checkTokenStatus(token);
            return {
                ...status,
                token_status: tokenStatus,
                integration_ready: tokenStatus.valid,
                deep_links: this.generateDeepLinks(baseUrl, token),
                connection_instructions: this.generateConnectionInstructions(baseUrl, token)
            };
        }

        return status;
    }
}