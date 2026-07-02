import axios from 'axios';
import { EventEmitter } from 'node:events';
import { Logger } from '../utils/logger.js';

/**
 * A parsed row from the SharePoint "OData MCP - Configuration" list.
 */
export interface SharePointConfigEntry {
    title: string;
    agentId: string;        // '*' for global/master entry
    services: string[];     // comma-separated patterns parsed into array
    entities: string[];     // comma-separated entity names, ['*'] = all
    capabilities: string[]; // comma-separated caps, ['*'] = all
}

/**
 * The full external configuration parsed from the SharePoint list.
 */
export interface ExternalConfig {
    masterEntry?: SharePointConfigEntry;
    agentEntries: Map<string, SharePointConfigEntry[]>; // keyed by UPPERCASE agentId
    lastUpdated: Date;
    lastError?: string;
}

/**
 * Singleton provider that loads OData service configuration from a SharePoint list
 * via the Microsoft Graph API, caching results in memory and polling for changes.
 *
 * Lifecycle:
 *   1. Call `SharePointConfigProvider.initialize(logger)` once at server startup.
 *      - Returns `null` if the required env vars are not set (graceful no-op).
 *   2. Access `SharePointConfigProvider.instance` from anywhere to read cached config.
 *   3. Call `instance.stopPolling()` on shutdown.
 */
export class SharePointConfigProvider extends EventEmitter {
    // ── singleton ────────────────────────────────────────────────────────
    private static _instance: SharePointConfigProvider | null = null;

    static get instance(): SharePointConfigProvider | null {
        return this._instance;
    }

    // ── internal state ───────────────────────────────────────────────────
    private config: ExternalConfig = {
        agentEntries: new Map(),
        lastUpdated: new Date(0),
    };

    private accessToken: string | null = null;
    private tokenExpiry = 0;
    private siteId: string | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    // ── settings (from env) ──────────────────────────────────────────────
    private readonly tenantId: string;
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly siteUrl: string;
    private readonly listName: string;
    private readonly pollIntervalMs: number;
    private readonly logger: Logger;

    // ── constructor (private – use initialize()) ─────────────────────────
    private constructor(logger: Logger) {
        super();
        this.logger = logger;
        this.tenantId = process.env.SHAREPOINT_TENANT_ID || '';
        this.clientId = process.env.SHAREPOINT_CLIENT_ID || '';
        this.clientSecret = process.env.SHAREPOINT_CLIENT_SECRET || '';
        this.siteUrl = process.env.SHAREPOINT_SITE_URL || '';
        this.listName = process.env.SHAREPOINT_LIST_NAME || 'OData MCP - Configuration';
        this.pollIntervalMs = parseInt(process.env.SHAREPOINT_POLL_INTERVAL_MS || '300000'); // 5 min
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Public API
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Bootstrap the provider.  Returns `null` when SharePoint credentials
     * are not configured (the server falls back to .env values).
     */
    static async initialize(logger: Logger): Promise<SharePointConfigProvider | null> {
        const tenantId = process.env.SHAREPOINT_TENANT_ID;
        const clientId = process.env.SHAREPOINT_CLIENT_ID;
        const clientSecret = process.env.SHAREPOINT_CLIENT_SECRET;
        const siteUrl = process.env.SHAREPOINT_SITE_URL;

        if (!tenantId || !clientId || !clientSecret || !siteUrl) {
            logger.info('📋 SharePoint config provider not configured – using .env fallback');
            return null;
        }

        const provider = new SharePointConfigProvider(logger);

        try {
            await provider.loadConfig();
            provider.startPolling();
            this._instance = provider;
            logger.info(`📋 SharePoint config provider initialised (polling every ${provider.pollIntervalMs / 1000}s)`);
            return provider;
        } catch (error) {
            logger.error('❌ Failed to initialise SharePoint config provider – falling back to .env', error);
            return null;
        }
    }

    /** Whether the provider was successfully initialised and has data. */
    isConfigured(): boolean {
        return this.config.lastUpdated.getTime() > 0;
    }

    /** Service patterns from the master entry (AgentId = "*"). */
    getMasterServicePatterns(): string[] | undefined {
        return this.config.masterEntry?.services;
    }

    /**
     * Build an agent-config object compatible with the shape returned by
     * `Config.getAgentConfig()`, sourced from the SharePoint list rows
     * whose AgentId matches the given id.
     */
    getAgentConfig(agentId: string): {
        servicePatterns: string[];
        entitiesWhitelist: Record<string, string[]>;
        capabilities: Record<string, Record<string, string[]>>;
        flatCapabilities: Record<string, string[]>;
        capabilityRules: { servicePattern: string; entityPattern: string; capabilities: string[] }[];
    } | null {
        if (!agentId) return null;

        const upperAgentId = agentId.toUpperCase();
        const entries = this.config.agentEntries.get(upperAgentId);
        if (!entries || entries.length === 0) return null;

        const servicePatterns: string[] = [];
        const entitiesWhitelist: Record<string, string[]> = {};
        const flatCapabilities: Record<string, string[]> = {};
        const capabilityRules: { servicePattern: string; entityPattern: string; capabilities: string[] }[] = [];

        for (const entry of entries) {
            // Collect service patterns
            for (const svc of entry.services) {
                if (!servicePatterns.includes(svc)) {
                    servicePatterns.push(svc);
                }
            }

            // Build entities whitelist and capabilities keyed per service
            for (const svc of entry.services) {
                const svcLower = svc.toLowerCase();

                // Entities
                if (entry.entities.length > 0 && entry.entities[0] !== '*') {
                    if (!entitiesWhitelist[svcLower]) {
                        entitiesWhitelist[svcLower] = [];
                    }
                    for (const ent of entry.entities) {
                        if (!entitiesWhitelist[svcLower].includes(ent)) {
                            entitiesWhitelist[svcLower].push(ent);
                        }
                    }
                }

                const capsToAssign = entry.capabilities[0] === '*'
                    ? ['read', 'create', 'update', 'delete']
                    : entry.capabilities;

                // Add to capability rules
                for (const ent of entry.entities) {
                    capabilityRules.push({
                        servicePattern: svc,
                        entityPattern: ent,
                        capabilities: capsToAssign
                    });
                }
            }
        }

        return {
            servicePatterns,
            entitiesWhitelist,
            capabilities: {}, // not used in current code
            flatCapabilities,
            capabilityRules,
        };
    }

    /** Stop the background polling timer. */
    stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            this.logger.info('📋 SharePoint config polling stopped');
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal – authentication
    // ══════════════════════════════════════════════════════════════════════

    private async ensureAccessToken(): Promise<string> {
        // Return cached token if still valid (with 60s buffer)
        if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
            return this.accessToken;
        }

        this.logger.debug('🔑 Acquiring Azure AD access token for Graph API');

        const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
        const params = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials',
        });

        const response = await axios.post(tokenUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10_000,
        });

        this.accessToken = response.data.access_token;
        this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
        this.logger.debug('🔑 Azure AD token acquired successfully');
        return this.accessToken!;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal – site resolution
    // ══════════════════════════════════════════════════════════════════════

    private parseSiteUrl(): { hostname: string; serverRelativePath: string } {
        let url = this.siteUrl.replace(/^https?:\/\//, '').replace(/:?\/?$/, '');
        const firstSlash = url.indexOf('/');
        if (firstSlash === -1) {
            throw new Error(`Invalid SHAREPOINT_SITE_URL: "${this.siteUrl}". Expected format: hostname/sites/SiteName`);
        }
        return {
            hostname: url.substring(0, firstSlash),
            serverRelativePath: url.substring(firstSlash),
        };
    }

    private async resolveSiteId(): Promise<string> {
        if (this.siteId) return this.siteId;

        const token = await this.ensureAccessToken();
        const { hostname, serverRelativePath } = this.parseSiteUrl();
        const graphUrl = `https://graph.microsoft.com/v1.0/sites/${hostname}:${serverRelativePath}`;

        this.logger.debug(`📋 Resolving SharePoint site ID from: ${graphUrl}`);

        const response = await axios.get(graphUrl, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10_000,
        });

        this.siteId = response.data.id;
        this.logger.info(`📋 Resolved SharePoint site ID: ${this.siteId}`);
        return this.siteId!;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal – list fetching & parsing
    // ══════════════════════════════════════════════════════════════════════

    private async fetchListItems(): Promise<SharePointConfigEntry[]> {
        const token = await this.ensureAccessToken();
        const siteId = await this.resolveSiteId();

        // Encode list name for URL (handles spaces and special characters)
        const encodedListName = encodeURIComponent(this.listName);
        const graphUrl = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${encodedListName}/items?$expand=fields($select=Title,AgentId,ODataService,Entity,test)`;

        this.logger.debug(`📋 Fetching SharePoint list items from: ${this.listName}`);

        const response = await axios.get(graphUrl, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15_000,
        });

        const items: SharePointConfigEntry[] = [];

        for (const item of response.data.value || []) {
            const fields = item.fields || {};

            const agentId = (fields.AgentId || '').trim();
            const servicesRaw = (fields.ODataService || '').trim();
            const entitiesRaw = (fields.Entity || '').trim();
            
            let capsRaw = '';
            if (Array.isArray(fields.test)) {
                capsRaw = fields.test.join(',');
            } else if (typeof fields.test === 'string') {
                capsRaw = fields.test.trim();
            }

            if (!agentId || !servicesRaw) {
                this.logger.warn(`📋 Skipping SharePoint row with missing AgentId or Services: "${fields.Title}"`);
                continue;
            }

            items.push({
                title: (fields.Title || '').trim(),
                agentId,
                services: this.parseCommaSeparated(servicesRaw),
                entities: entitiesRaw ? this.parseCommaSeparated(entitiesRaw) : ['*'],
                capabilities: capsRaw ? this.parseCommaSeparated(capsRaw) : ['*'],
            });
        }

        this.logger.info(`📋 Fetched ${items.length} config entries from SharePoint list "${this.listName}"`);
        return items;
    }

    private parseCommaSeparated(value: string): string[] {
        if (!value || value === '*') return ['*'];
        return value.split(',').map(s => s.trim()).filter(Boolean);
    }

    private buildExternalConfig(entries: SharePointConfigEntry[]): ExternalConfig {
        const config: ExternalConfig = {
            agentEntries: new Map(),
            lastUpdated: new Date(),
        };

        for (const entry of entries) {
            if (entry.agentId === '*') {
                config.masterEntry = entry;
                this.logger.debug(`📋 Master entry loaded: ${entry.services.length} service pattern(s)`);
            } else {
                const key = entry.agentId.toUpperCase();
                if (!config.agentEntries.has(key)) {
                    config.agentEntries.set(key, []);
                }
                config.agentEntries.get(key)!.push(entry);
            }
        }

        const agentCount = config.agentEntries.size;
        this.logger.info(`📋 Config parsed: master=${config.masterEntry ? 'yes' : 'no'}, agents=${agentCount}`);
        return config;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal – load & poll
    // ══════════════════════════════════════════════════════════════════════

    private async loadConfig(): Promise<void> {
        const entries = await this.fetchListItems();
        this.config = this.buildExternalConfig(entries);
    }

    private startPolling(): void {
        if (this.pollTimer) return;

        this.pollTimer = setInterval(async () => {
            try {
                this.logger.debug('📋 Polling SharePoint for config changes...');
                const entries = await this.fetchListItems();
                const newConfig = this.buildExternalConfig(entries);

                // Deep compare to detect any changes in master or agent entries
                // We serialize to JSON to perform a simple deep equality check
                // We need to omit the 'lastUpdated' date from the comparison
                const serializeForCompare = (conf: ExternalConfig) => {
                    const agentEntriesObj = Object.fromEntries(conf.agentEntries);
                    return JSON.stringify({
                        masterEntry: conf.masterEntry,
                        agentEntries: agentEntriesObj
                    });
                };

                const oldState = serializeForCompare(this.config);
                const newState = serializeForCompare(newConfig);

                this.config = newConfig;

                if (oldState !== newState) {
                    this.logger.info(`📋 ⚡ SharePoint configuration changed!`);
                    this.emit('configChanged', newConfig);
                }
            } catch (error) {
                // Keep the old cached config – do not crash
                this.config.lastError = error instanceof Error ? error.message : String(error);
                this.logger.warn(`📋 ⚠️ SharePoint poll failed (using cached config): ${this.config.lastError}`);
            }
        }, this.pollIntervalMs);

        // Prevent the timer from keeping the process alive
        if (this.pollTimer.unref) {
            this.pollTimer.unref();
        }
    }
}
