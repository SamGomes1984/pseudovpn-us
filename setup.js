#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

class PseudoVPNSetup {
    constructor() {
        this.config = {
            regions: {
                US: {
                    name: "United States",
                    workers: []
                },
                EU: {
                    name: "Europe", 
                    workers: []
                },
                AP: {
                    name: "Asia Pacific",
                    workers: []
                }
            },
            auth: {
                tokenDuration: 300,
                refreshBuffer: 60,
            },
            health: {
                checkInterval: 30000,
                timeout: 5000
            }
        };
    }

    async checkDependencies() {
        console.log('🔍 Checking dependencies...');
        
        const dependencies = [
            { name: 'Node.js', command: 'node', args: ['--version'], required: true },
            { name: 'npm', command: 'npm', args: ['--version'], required: true },
            { name: 'Wrangler CLI', command: 'wrangler', args: ['--version'], required: false },
            { name: 'Deno', command: 'deno', args: ['--version'], required: false },
            { name: 'DeployCtl', command: 'deployctl', args: ['--version'], required: false }
        ];

        const results = await Promise.all(
            dependencies.map(dep => this.checkCommand(dep))
        );

        results.forEach((result, index) => {
            const dep = dependencies[index];
            if (result.success) {
                console.log(`  ✅ ${dep.name}: ${result.version}`);
            } else if (dep.required) {
                console.log(`  ❌ ${dep.name}: Not found (required)`);
                process.exit(1);
            } else {
                console.log(`  ⚠️  ${dep.name}: Not found (optional)`);
            }
        });
    }

    async checkCommand(dep) {
        return new Promise((resolve) => {
            const child = spawn(dep.command, dep.args, { stdio: 'pipe', shell:true });
            let output = '';
            
            child.stdout.on('data', (data) => output += data.toString());
            child.stderr.on('data', (data) => output += data.toString());
            
            child.on('close', (code) => {
                resolve({
                    success: code === 0,
                    version: code === 0 ? output.trim().split('\n')[0] : 'Not found'
                });
            });

            child.on('error', () => {
                resolve({ success: false, version: 'Not found' });
            });
        });
    }

    async createProjectStructure() {
        console.log('📁 Creating project structure...');
        
        const directories = ['logs', 'config', 'scripts'];
        
        for (const dir of directories) {
            try {
                await fs.mkdir(dir, { recursive: true });
                console.log(`  Created: ${dir}/`);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    console.error(`  Failed to create ${dir}: ${error.message}`);
                }
            }
        }
    }

    async generateKeys() {
        console.log('🔐 Generating encryption keys...');
        
        const crypto = require('crypto');
        const keys = {
            sessionSecret: crypto.randomBytes(32).toString('hex'),
            apiKey: crypto.randomBytes(24).toString('hex'),
            refreshToken: crypto.randomBytes(16).toString('hex')
        };

        await fs.writeFile('config/keys.json', JSON.stringify(keys, null, 2));
        console.log('  ✅ Encryption keys generated');
        
        // Set restrictive permissions
        try {
            await fs.chmod('config/keys.json', 0o600);
        } catch (error) {
            console.warn('  ⚠️  Could not set file permissions');
        }
    }

    async promptUserInput(question) {
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer.trim());
            });
        });
    }

    async configureEndpoints() {
        console.log('🌐 Configuring worker endpoints...');
        console.log('Enter your deployed worker URLs (press Enter to skip):');
        
        // US endpoints
        const usWorker = await this.promptUserInput('US Cloudflare Worker URL: ');
        if (usWorker) {
            this.config.regions.US.workers.push(usWorker);
        }
        
        const usDeno = await this.promptUserInput('US Deno Deploy URL: ');
        if (usDeno) {
            this.config.regions.US.workers.push(usDeno);
        }

        // EU endpoints
        const euWorker = await this.promptUserInput('EU Cloudflare Worker URL: ');
        if (euWorker) {
            this.config.regions.EU.workers.push(euWorker);
        }

        const euDeno = await this.promptUserInput('EU Deno Deploy URL: ');
        if (euDeno) {
            this.config.regions.EU.workers.push(euDeno);
        }

        // AP endpoints
        const apWorker = await this.promptUserInput('AP Cloudflare Worker URL: ');
        if (apWorker) {
            this.config.regions.AP.workers.push(apWorker);
        }

        const apDeno = await this.promptUserInput('AP Deno Deploy URL: ');
        if (apDeno) {
            this.config.regions.AP.workers.push(apDeno);
        }

        // Add default test endpoints if none provided
        if (this.config.regions.US.workers.length === 0) {
            this.config.regions.US.workers.push('https://pseudovpn-us.your-subdomain.workers.dev');
        }
        if (this.config.regions.EU.workers.length === 0) {
            this.config.regions.EU.workers.push('https://pseudovpn-eu.your-subdomain.workers.dev');
        }
        if (this.config.regions.AP.workers.length === 0) {
            this.config.regions.AP.workers.push('https://pseudovpn-ap.your-subdomain.workers.dev');
        }
    }

    async saveConfiguration() {
        console.log('💾 Saving configuration...');
        
        await fs.writeFile('config.json', JSON.stringify(this.config, null, 2));
        console.log('  ✅ Configuration saved to config.json');
    }

    async createDeploymentScripts() {
        console.log('📜 Creating deployment scripts...');
        
        // Cloudflare deployment script
        const cfScript = `#!/bin/bash
echo "🚀 Deploying to Cloudflare Workers..."

echo "Deploying US East..."
wrangler publish --env US_EAST

echo "Deploying EU West..."  
wrangler publish --env EU_WEST

echo "Deploying Asia Pacific..."
wrangler publish --env ASIA_PACIFIC

echo "✅ Cloudflare Workers deployed!"
echo "Update config.json with your worker URLs"
`;

        // Deno Deploy script
        const denoScript = `#!/bin/bash
echo "🦕 Deploying to Deno Deploy..."

echo "Deploying main worker..."
deployctl deploy --project=pseudovpn-main worker-deno.js

echo "✅ Deno Deploy worker deployed!"
echo "Update config.json with your Deno Deploy URL"
`;

        await fs.writeFile('scripts/deploy-cloudflare.sh', cfScript);
        await fs.writeFile('scripts/deploy-deno.sh', denoScript);
        
        // Make scripts executable
        try {
            await fs.chmod('scripts/deploy-cloudflare.sh', 0o755);
            await fs.chmod('scripts/deploy-deno.sh', 0o755);
        } catch (error) {
            console.warn('  ⚠️  Could not set script permissions');
        }

        console.log('  ✅ Deployment scripts created');
    }

    async createTestScript() {
        console.log('🧪 Creating test script...');
        
        const testScript = `#!/usr/bin/env node

const PseudoVPNClient = require('./client.js');

async function runTests() {
    console.log('🧪 Running PseudoVPN Tests\\n');
    
    const client = new PseudoVPNClient();
    
    try {
        // Test 1: List available countries
        console.log('Test 1: Listing countries');
        client.listCountries();
        
        // Test 2: Health check all regions
        console.log('\\nTest 2: Health checks');
        const regions = Object.keys(client.config.regions);
        
        for (const region of regions) {
            const workers = client.config.regions[region].workers;
            for (const worker of workers) {
                try {
                    const health = await client.healthCheck(worker);
                    console.log(\`  \${region}: \${health.status} (\${health.latency}ms)\`);
                } catch (error) {
                    console.log(\`  \${region}: error - \${error.message}\`);
                }
            }
        }
        
        // Test 3: Connection test
        console.log('\\nTest 3: Connection test');
        const testRegion = regions[0];
        if (testRegion) {
            try {
                const result = await client.connect(testRegion);
                console.log(\`  ✅ Connected to \${testRegion}\`);
                console.log(\`  IP: \${result.ip}, Country: \${result.country}\`);
                await client.disconnect();
            } catch (error) {
                console.log(\`  ❌ Connection failed: \${error.message}\`);
            }
        }
        
        console.log('\\n🎉 Tests completed!');
        
    } catch (error) {
        console.error('Test suite failed:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    runTests();
}
`;

        await fs.writeFile('scripts/test.js', testScript);
        
        try {
            await fs.chmod('scripts/test.js', 0o755);
        } catch (error) {
            console.warn('  ⚠️  Could not set test script permissions');
        }

        console.log('  ✅ Test script created');
    }

    async displayInstructions() {
        console.log('\n🎉 Setup complete!\n');
        
        console.log('Next steps:');
        console.log('1. Deploy workers to serverless platforms:');
        console.log('   • Cloudflare: ./scripts/deploy-cloudflare.sh');
        console.log('   • Deno Deploy: ./scripts/deploy-deno.sh');
        console.log('');
        console.log('2. Update config.json with your actual worker URLs');
        console.log('');
        console.log('3. Test the system:');
        console.log('   • Health check: node client.js --test-all');
        console.log('   • Connect to US: node client.js --country=US');
        console.log('   • Run tests: node scripts/test.js');
        console.log('');
        console.log('4. Benchmark performance:');
        console.log('   • node client.js --benchmark=US');
        console.log('');
        console.log('📚 See the documentation for more advanced usage!');
    }

    async run() {
        try {
            console.log('🚀 PseudoVPN Setup Starting...\n');
            
            await this.checkDependencies();
            await this.createProjectStructure();
            await this.generateKeys();
            await this.configureEndpoints();
            await this.saveConfiguration();
            await this.createDeploymentScripts();
            await this.createTestScript();
            await this.displayInstructions();
            
        } catch (error) {
            console.error('❌ Setup failed:', error.message);
            process.exit(1);
        }
    }
}

// Run setup if called directly
if (require.main === module) {
    const setup = new PseudoVPNSetup();
    setup.run();
}

module.exports = PseudoVPNSetup;
