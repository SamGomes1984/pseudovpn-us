// Cloudflare Worker for Pseudo-VPN
// Deploy this to multiple regions for global coverage

const WORKER_VERSION = '1.0.0';
const SESSION_TIMEOUT = 300000; // 5 minutes

// In-memory session store (use KV storage for production)
let activeSessions = new Map();

// Cleanup expired sessions
function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now > session.expires) {
            activeSessions.delete(sessionId);
        }
    }
}

// Validate session token (simplified)
function validateToken(token, sessionId) {
    if (!token) return false;
    
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return false;
        
        const payload = JSON.parse(atob(parts[1]));
        
        // Check expiry
        if (Date.now() > payload.expires) return false;
        
        // Check session ID match
        if (payload.sessionId !== sessionId) return false;
        
        return payload;
    } catch {
        return false;
    }
}

// Get client IP and geolocation info
function getClientInfo(request) {
    const ip = request.headers.get('CF-Connecting-IP') || 
               request.headers.get('X-Forwarded-For') || 
               request.headers.get('X-Real-IP') ||
               '127.0.0.1';
               
    const country = request.cf?.country || 'Unknown';
    const countryCode = request.cf?.colo || 'XX';
    const city = request.cf?.city || 'Unknown';
    const region = request.cf?.region || 'Unknown';
    const timezone = request.cf?.timezone || 'UTC';
    const asn = request.cf?.asn || 0;
    const datacenter = request.cf?.colo || 'Unknown';
    
    return {
        ip,
        country,
        countryCode,
        city,
        region,
        timezone,
        asn,
        datacenter,
        userAgent: request.headers.get('User-Agent') || 'Unknown'
    };
}

// Health check endpoint
async function handleHealthCheck(request) {
    cleanupExpiredSessions();
    
    const health = {
        status: 'healthy',
        version: WORKER_VERSION,
        timestamp: Date.now(),
        uptime: Date.now(), // In production, track actual uptime
        activeSessions: activeSessions.size,
        region: request.cf?.colo || 'Unknown',
        datacenter: request.cf?.colo || 'Unknown',
        country: request.cf?.country || 'Unknown'
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
        
        // Validate token
        const tokenPayload = validateToken(token, sessionId);
        if (!tokenPayload) {
            return new Response(JSON.stringify({
                error: 'Invalid or expired token'
            }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        
        // Create session
        const clientInfo = getClientInfo(request);
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
                region: request.cf?.colo || 'Unknown',
                datacenter: request.cf?.colo || 'Unknown',
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
        
        // Validate session
        const session = activeSessions.get(sessionId);
        if (!session || Date.now() > session.expires) {
            activeSessions.delete(sessionId);
            return new Response('Session expired', { status: 401 });
        }
        
        // Validate token
        if (!validateToken(token, sessionId)) {
            return new Response('Invalid token', { status: 401 });
        }
        
        // Extract target URL from query params or path
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            return new Response('Target URL required', { status: 400 });
        }
        
        // Update session activity
        session.lastActivity = Date.now();
        
        // Make the proxied request
        const proxyRequest = new Request(targetUrl, {
            method: request.method,
            headers: {
                ...Object.fromEntries(request.headers.entries()),
                'User-Agent': 'PseudoVPN-Worker/1.0',
                'X-Forwarded-For': session.clientInfo.ip,
                'X-Original-Country': session.clientInfo.country
            },
            body: request.body
        });
        
        // Remove internal headers
        proxyRequest.headers.delete('X-Session-ID');
        proxyRequest.headers.delete('Authorization');
        
        const response = await fetch(proxyRequest);
        
        // Return response with CORS headers
        const proxyResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: {
                ...Object.fromEntries(response.headers.entries()),
                'Access-Control-Allow-Origin': '*',
                'X-Proxy-Country': session.clientInfo.country,
                'X-Proxy-Datacenter': request.cf?.colo || 'Unknown'
            }
        });
        
        return proxyResponse;
        
    } catch (error) {
        return new Response(`Proxy error: ${error.message}`, { status: 500 });
    }
}

// Get current IP info
async function handleIPInfo(request) {
    const clientInfo = getClientInfo(request);
    
    return new Response(JSON.stringify({
        ...clientInfo,
        worker: {
            region: request.cf?.colo || 'Unknown',
            datacenter: request.cf?.colo || 'Unknown',
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
async function handleCORS(request) {
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
        return handleCORS(request);
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
                service: 'PseudoVPN Worker',
                version: WORKER_VERSION,
                endpoints: ['/health', '/connect', '/proxy', '/ip'],
                region: request.cf?.colo || 'Unknown',
                country: request.cf?.country || 'Unknown'
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
            
        default:
            return new Response('Not Found', { status: 404 });
    }
    
    return new Response('Method Not Allowed', { status: 405 });
}

// Event listeners for Cloudflare Workers
addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});

// Scheduled cleanup (if using cron triggers)
addEventListener('scheduled', event => {
    event.waitUntil(cleanupExpiredSessions());
});
