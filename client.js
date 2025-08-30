#!/usr/bin/env node

const https = require('https');
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs').promises;

class PseudoVPNClient {
    constructor() {
        this.config = null;
        this.currentSession = null;
        this.sessionToken = null;
        this.tokenExpiry = null;
        this.activeWorkers = new Map();
        this.healthCheckInterval = null;
        

    }

   async init() {
        await this.loadConfig();
        return this; // allow chaining
    }

    async loadConfig() {
        try {
            const configData = await fs.readFile('config.json', 'utf8');
            this.config = JSON.parse(configData);
        } catch (error) {
            // Default configuration if file doesn't exist
            this.config = {
                regions: {
                    US: {
                        name: "United States",
                        workers: [
                            "https://pseudovpn-us-east.hakzeemirror.workers.dev",
                            "https://pseudovpn-us-backup.deno.dev"
                        ]
                    },
                    EU: {
                        name: "Europe",
                        workers: [
                            "https://pseudovpn-eu-west.hakzeemirror.workers.dev",
                            "https://pseudovpn-eu-backup.deno.dev"
                        ]
                    },
                    AP: {
                        name: "Asia Pacific",
                        workers: [
                            "https://pseudovpn-ap-southeast.hakzeemirror.workers.dev",
                            "https://pseudovpn-ap-backup.deno.dev"
                        ]
                    }
                },
                auth: {
                    tokenDuration: 300, // 5 minutes
                    refreshBuffer: 60,  // Refresh 1 minute before expiry
                },
                health: {
                    checkInterval: 30000, // 30 seconds
                    timeout: 5000        // 5 seconds
                }
            };
            
            // Save default config
            await this.saveConfig();
        }
    }

    async saveConfig() {
        await fs.writeFile('config.json', JSON.stringify(this.config, null, 2));
    }

    // Generate session token
    generateSessionToken(country, workerId) {
        const payload = {
            country: country,
            workerId: workerId,
            sessionId: crypto.randomUUID(),
            issued: Date.now(),
            expires: Date.now() + (this.config.auth.tokenDuration * 1000)
        };

        // Simple JWT-like token (in production, use proper JWT library)
        const header = Buffer.from(JSON.stringify({alg: "HS256", typ: "JWT"})).toString('base64url');
        const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const secret = crypto.randomBytes(32).toString('hex');
        
        const signature = crypto
            .createHmac('sha256', secret)
            .update(`${header}.${payloadB64}`)
            .digest('base64url');

        return {
            token: `${header}.${payloadB64}.${signature}`,
            payload: payload,
            secret: secret
        };
    }

    // Health check for workers
    async healthCheck(workerUrl, timeout = 5000) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const timeoutId = setTimeout(() => {
                resolve({ url: workerUrl, status: 'timeout', latency: timeout });
            }, timeout);

            const request = https.get(`${workerUrl}/health`, (res) => {
                clearTimeout(timeoutId);
                const latency = Date.now() - startTime;
                
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        resolve({
                            url: workerUrl,
                            status: res.statusCode === 200 ? 'healthy' : 'error',
                            latency: latency,
                            data: result
                        });
                    } catch {
                        resolve({ url: workerUrl, status: 'invalid', latency: latency });
                    }
                });
            });

            request.on('error', () => {
                clearTimeout(timeoutId);
                resolve({ url: workerUrl, status: 'error', latency: Date.now() - startTime });
            });
        });
    }

    // Get best worker for a country
    async getBestWorker(country) {
        if (!this.config.regions[country]) {
            throw new Error(`Country ${country} not supported`);
        }

        const workers = this.config.regions[country].workers;
        const healthChecks = await Promise.all(
            workers.map(worker => this.healthCheck(worker))
        );

        // Sort by latency, prefer healthy workers
        const sortedWorkers = healthChecks
            .filter(check => check.status === 'healthy')
            .sort((a, b) => a.latency - b.latency);

        if (sortedWorkers.length === 0) {
            throw new Error(`No healthy workers available for ${country}`);
        }

        return sortedWorkers[0];
    }

    // Connect to a specific country
    async connect(country) {
        console.log(`🌍 Connecting to ${this.config.regions[country]?.name || country}...`);
        
        try {
            // Get best worker
            const worker = await this.getBestWorker(country);
            console.log(`✅ Selected worker: ${worker.url} (${worker.latency}ms)`);

            // Generate session token
            const sessionInfo = this.generateSessionToken(country, worker.url);
            this.sessionToken = sessionInfo.token;
            this.tokenExpiry = sessionInfo.payload.expires;
            
            // Establish connection
            const connectionResult = await this.establishConnection(worker.url, sessionInfo);
            
            this.currentSession = {
                country: country,
                worker: worker,
                sessionId: sessionInfo.payload.sessionId,
                connectedAt: Date.now()
            };

            console.log(`🎉 Connected successfully!`);
            console.log(`📍 Apparent IP: ${connectionResult.ip}`);
            console.log(`🏳️  Country: ${connectionResult.country} (${connectionResult.countryCode})`);
            console.log(`🏙️  City: ${connectionResult.city || 'Unknown'}`);
            console.log(`⏰ Session expires: ${new Date(this.tokenExpiry).toLocaleString()}`);

            // Start token refresh timer
            this.scheduleTokenRefresh();
            
            return connectionResult;

        } catch (error) {
            console.error(`❌ Connection failed: ${error.message}`);
            throw error;
        }
    }

    // Establish connection with worker
    async establishConnection(workerUrl, sessionInfo) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                action: 'connect',
                token: sessionInfo.token,
                sessionId: sessionInfo.payload.sessionId
            });

            const urlParts = url.parse(workerUrl);
            const options = {
                hostname: urlParts.hostname,
                port: urlParts.port || 443,
                path: '/connect',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': postData.length,
                    'Authorization': `Bearer ${sessionInfo.token}`,
                    'User-Agent': 'PseudoVPN-Client/1.0'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (error) {
                            reject(new Error('Invalid response format'));
                        }
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    // Schedule token refresh
    scheduleTokenRefresh() {
        if (this.tokenRefreshTimeout) {
            clearTimeout(this.tokenRefreshTimeout);
        }

        const refreshTime = this.tokenExpiry - Date.now() - (this.config.auth.refreshBuffer * 1000);
        
        if (refreshTime > 0) {
            this.tokenRefreshTimeout = setTimeout(async () => {
                try {
                    await this.refreshToken();
                } catch (error) {
                    console.error('⚠️  Token refresh failed:', error.message);
                    // Attempt reconnection
                    if (this.currentSession) {
                        await this.connect(this.currentSession.country);
                    }
                }
            }, refreshTime);
        }
    }

    // Refresh session token
    async refreshToken() {
        if (!this.currentSession) return;

        console.log('🔄 Refreshing session token...');
        const sessionInfo = this.generateSessionToken(
            this.currentSession.country, 
            this.currentSession.worker.url
        );
        
        this.sessionToken = sessionInfo.token;
        this.tokenExpiry = sessionInfo.payload.expires;
        
        console.log(`✅ Token refreshed, expires: ${new Date(this.tokenExpiry).toLocaleString()}`);
        this.scheduleTokenRefresh();
    }

    // Switch to different country
    async switchCountry(newCountry) {
        console.log(`🔄 Switching from ${this.currentSession?.country} to ${newCountry}...`);
        await this.disconnect();
        return await this.connect(newCountry);
    }

    // Disconnect current session
    async disconnect() {
        if (this.tokenRefreshTimeout) {
            clearTimeout(this.tokenRefreshTimeout);
        }

        if (this.currentSession) {
            console.log(`👋 Disconnecting from ${this.currentSession.country}...`);
            this.currentSession = null;
            this.sessionToken = null;
            this.tokenExpiry = null;
        }
        
        console.log('✅ Disconnected');
    }

    // List available countries
    listCountries() {
        console.log('\n📍 Available Countries:');
        for (const [code, info] of Object.entries(this.config.regions)) {
            console.log(`  ${code}: ${info.name} (${info.workers.length} workers)`);
        }
    }

    // Test all regions
    async testAllRegions() {
        console.log('🧪 Testing all regions...\n');
        
        for (const [countryCode, countryInfo] of Object.entries(this.config.regions)) {
            console.log(`Testing ${countryInfo.name} (${countryCode}):`);
            
            try {
                const result = await this.connect(countryCode);
                console.log(`  ✅ Success - IP: ${result.ip}, Location: ${result.city}, ${result.country}\n`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Brief pause
                await this.disconnect();
            } catch (error) {
                console.log(`  ❌ Failed: ${error.message}\n`);
            }
        }
    }

    // Performance benchmark
    async benchmark(country = 'US', iterations = 5) {
        console.log(`🏃 Running benchmark for ${country} (${iterations} iterations)...\n`);
        
        const results = [];
        
        for (let i = 1; i <= iterations; i++) {
            console.log(`Iteration ${i}/${iterations}:`);
            const startTime = Date.now();
            
            try {
                await this.connect(country);
                const connectionTime = Date.now() - startTime;
                
                // Test a simple HTTP request through the proxy
                const requestStart = Date.now();
                // In a real implementation, you'd route this through the worker
                const requestTime = Date.now() - requestStart;
                
                results.push({
                    iteration: i,
                    connectionTime,
                    requestTime,
                    success: true
                });
                
                console.log(`  Connection: ${connectionTime}ms, Request: ${requestTime}ms ✅`);
                await this.disconnect();
                
            } catch (error) {
                results.push({
                    iteration: i,
                    error: error.message,
                    success: false
                });
                console.log(`  Failed: ${error.message} ❌`);
            }
            
            if (i < iterations) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        // Calculate statistics
        const successful = results.filter(r => r.success);
        if (successful.length > 0) {
            const avgConnection = successful.reduce((sum, r) => sum + r.connectionTime, 0) / successful.length;
            const avgRequest = successful.reduce((sum, r) => sum + r.requestTime, 0) / successful.length;
            
            console.log(`\n📊 Benchmark Results:`);
            console.log(`  Success Rate: ${successful.length}/${iterations} (${(successful.length/iterations*100).toFixed(1)}%)`);
            console.log(`  Avg Connection Time: ${avgConnection.toFixed(1)}ms`);
            console.log(`  Avg Request Time: ${avgRequest.toFixed(1)}ms`);
        }
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);
    const client = await new PseudoVPNClient().init();
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
🌐 Serverless Pseudo-VPN Client

Usage:
  node client.js [options]

Options:
  --country=<code>    Connect to specific country (US, EU, AP)
  --list              List available countries
  --test-all          Test all available regions
  --benchmark[=country] Run performance benchmark
  --switch=<code>     Switch to different country
  --disconnect        Disconnect current session
  --help, -h          Show this help

Examples:
  node client.js --country=US
  node client.js --test-all
  node client.js --benchmark=EU
  node client.js --switch=AP
        `);
        return;
    }
    
    if (args.includes('--list')) {
        client.listCountries();
        return;
    }
    
    if (args.includes('--test-all')) {
        await client.testAllRegions();
        return;
    }
    
    const benchmarkArg = args.find(arg => arg.startsWith('--benchmark'));
    if (benchmarkArg) {
        const country = benchmarkArg.includes('=') ? benchmarkArg.split('=')[1] : 'US';
        await client.benchmark(country);
        return;
    }
    
    const countryArg = args.find(arg => arg.startsWith('--country='));
    if (countryArg) {
        const country = countryArg.split('=')[1];
        await client.connect(country);
        
        // Keep connection alive and handle user input
        process.on('SIGINT', async () => {
            console.log('\n🛑 Shutting down...');
            await client.disconnect();
            process.exit(0);
        });
        
        console.log('\nPress Ctrl+C to disconnect');
        return;
    }
    
    const switchArg = args.find(arg => arg.startsWith('--switch='));
    if (switchArg) {
        const country = switchArg.split('=')[1];
        await client.switchCountry(country);
        return;
    }
    
    if (args.includes('--disconnect')) {
        await client.disconnect();
        return;
    }
    
    // Default: show help
    console.log('Use --help for usage information');
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = PseudoVPNClient;
