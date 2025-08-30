// Deno Deploy Worker for Pseudo-VPN
// Alternative serverless platform implementation

const WORKER_VERSION = '1.0.0';
const SESSION_TIMEOUT = 300000; // 5 minutes

// In-memory session store
const activeSessions = new Map();

// Cleanup expired sessions
function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now > session.expires) {
            activeSessions.delete(sessionId);
        }
    }
}

// Validate session token
function validateToken(token, sessionId) {
    if (!token) return false;
    
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return false;
        
        const payload = JSON.parse(atob(parts[1]));
        
        if (Date.now() > payload.expires) return false;
        if (payload.sessionId !== sessionId) return false;
        
        return payload;
    } catch {
        return false;
    }
}

// Get client IP and location (Deno Deploy specific)
function getClientInfo(request) {
    const forwarded = request.headers.get('X-Forwarded-For');
    const ip = forwarded ? forwarded.split(',')[0].trim() : '127.0.0.1';
    
    // Deno Deploy doesn't provide as much geo info as Cloudflare
    // You might need to use a GeoIP service here
    const userAgent = request.headers.get('User-Agent') || 'Unknown';
    
    return {
        ip,
        country: 'Unknown', // Would need external GeoIP service
        countryCode: 'XX',
        city: 'Unknown',
        region: 'Unknown',
        timezone: 'UTC',
        asn: 0,
        datacenter: 'Deno-Deploy',
        userAgent,
        platform: 'Deno Deploy'
    };
}

// Enhanced GeoIP lookup using external service
async function getEnhancedClientInfo(request) {
    const basicInfo = getClientInfo(request);
    
    try {
        // Use a free GeoIP service (in production, use a reliable paid service)
        const geoResponse = await fetch(`http://ip-api.com/json/${basicInfo.ip}?fields=status,country,countryCode,region,city,timezone,as`);
        
        if (geoResponse.ok) {
            const geoData = await geoResponse.json();
            
            if (geoData.status === 'success') {
                return {
                    ...basicInfo,
                    country: geoData.country,
                    countryCode: geoData.countryCode,
                    region: geoData.region,
                    city: geoData.city,
                    timezone: geoData.timezone,
                    asn: geoData.as || 0
                };
            }
        }
    } catch (error) {
        console.warn('GeoIP lookup failed:', error.message);
    }
    
    return basicInfo;
}

// Health check endpoint
async function handleHealthCheck(request) {
    cleanupExpiredSessions();
    
    const health = {
        status: 'healthy',
        version: WORKER_VERSION,
        platform: 'Deno Deploy',
        timestamp: Date.now(),
        uptime: Date.now(),
        activeSessions: activeSessions.size,
        region: 'deno-deploy',
        datacenter: 'Deno Deploy Edge'
    };
    
    return new Response(JSON.stringify(health), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
        }
    });
}

// Connection establishment
async function handleConnect(request) {
    try {
        const body = await request.json();
        const { token, sessionId, action } = body;
        
        if (action !== 'connect' || !token || !sessionId) {
            return new Response(JSON.stringify({
                error: 'Invalid request parameters'
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        
        const tokenPayload = validateToken(token, sessionId);
        if (!tokenPayload) {
            return new Response(JSON.stringify({
                error: 'Invalid or expired token'
            }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Get enhanced client info with GeoIP
        const clientInfo = await getEnhancedClientInfo(request);
        
        const session = {
            sessionId,
            created: Date.now(),
            expires: tokenPayload.expires,
            country: tokenPayload.country,
            clientInfo,
            lastActivity: Date.now()
        };
        
        activeSessions.set(sessionId, session);
        
        const response = {
            success: true,
            sessionId,
            ...clientInfo,
            worker: {
                region: 'deno-deploy',
                datacenter: 'Deno Deploy Edge',
                platform: 'Deno Deploy',
                version: WORKER_VERSION
            },
            sessionExpires: new Date(tokenPayload.expires).toISOString()
        };
        
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
        
    } catch (error) {
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

// Proxy HTTP requests
async function handleProxy(request) {
    try {
        const url = new URL(request.url);
        const sessionId = request.headers.get('X-Session-ID');
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        
        if (!sessionId || !token) {
            return new Response('Unauthorized', { status: 401 });
        }
        
        const session = activeSessions.get(sessionId);
        if (!session || Date.now() > session.expires) {
            activeSessions.delete(sessionId);
            return new Response('Session expired', { status: 401 });
        }
        
        if (!validateToken(token, sessionId)) {
            return new Response('Invalid token', { status: 401 });
        }
        
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            return new Response('Target URL required', { status: 400 });
        }
        
        session.lastActivity = Date.now();
        
        // Create proxy request
        const proxyHeaders = new Headers();
        
        // Copy relevant headers
        for (const [key, value] of request.headers.entries()) {
            if (!['host', 'x-session-id', 'authorization'].includes(key.toLowerCase())) {
                proxyHeaders.set(key, value);
            }
        }
        
        proxyHeaders.set('User-Agent', 'PseudoVPN-Deno/1.0');
        proxyHeaders.set('X-Forwarded-For', session.clientInfo.ip);
        proxyHeaders.set('X-Original-Country', session.clientInfo.country);
        
        const proxyRequest = new Request(targetUrl, {
            method: request.method,
            headers: proxyHeaders,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined
        });
        
        const response = await fetch(proxyRequest);
        
        // Create response with CORS headers
        const responseHeaders = new Headers();
        
        // Copy response headers
        for (const [key, value] of response.headers.entries()) {
            responseHeaders.set(key, value);
        }
        
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('X-Proxy-Country', session.clientInfo.country);
        responseHeaders.set('X-Proxy-Platform', 'Deno Deploy');
        
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });
        
    } catch (error) {
        return new Response(`Proxy error: ${error.message}`, { status: 500 });
    }
}

// Get current IP info
async function handleIPInfo(request) {
    const clientInfo = await getEnhancedClientInfo(request);
    
    return new Response(JSON.stringify({
        ...clientInfo,
        worker: {
            region: 'deno-deploy',
            datacenter: 'Deno Deploy Edge',
            platform: 'Deno Deploy',
            version: WORKER_VERSION
        },
        timestamp: new Date().toISOString()
    }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// Handle CORS preflight
async function handleCORS() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-ID',
            'Access-Control-Max-Age': '86400'
        }
    });
}

// Main request handler
async function handleRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return handleCORS();
    }
    
    // Route requests
    switch (path) {
        case '/health':
            return handleHealthCheck(request);
            
        case '/connect':
            if (request.method === 'POST') {
                return handleConnect(request);
            }
            break;
            
        case '/proxy':
            return handleProxy(request);
            
        case '/ip':
        case '/info':
            return handleIPInfo(request);
            
        case '/':
            return new Response(JSON.stringify({
                service: 'PseudoVPN Deno Worker',
                version: WORKER_VERSION,
                platform: 'Deno Deploy',
                endpoints: ['/health', '/connect', '/proxy', '/ip'],
                region: 'deno-deploy'
            }), {
                status: 200,
                headers: { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            });
            
        default:
            return new Response('Not Found', { status: 404 });
    }
    
    return new Response('Method Not Allowed', { status: 405 });
}

// Deno Deploy event handler
Deno.serve(handleRequest);

// Optional: Cleanup timer
setInterval(() => {
    cleanupExpiredSessions();
}, 60000); // Clean up every minute
