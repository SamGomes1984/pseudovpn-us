// Express server for Pseudo-VPN (Render version)
// Converted from Cloudflare Worker

import express from "express";
import fetch from "node-fetch"; // Needed for proxying (if Node < 18)
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 8080;

const WORKER_VERSION = "1.0.0";
const SESSION_TIMEOUT = 300000; // 5 minutes
let activeSessions = new Map();

// Middleware
app.use(bodyParser.json());

// Cleanup expired sessions
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now > session.expires) {
      activeSessions.delete(sessionId);
    }
  }
}



let renderRegion = "Unknown";
const IPAPI_KEY = "e23d6cfa5d0bb9b27aa118e1c785321d"; // replace with your actual key

async function fetchRegionByIP() {
  try {
    // You can pass no IP to get your server's IP info
    const res = await fetch(`http://api.ipapi.com/check?access_key=${IPAPI_KEY}`);
    const data = await res.json();

    const city = data.city || "Unknown";
    const country = data.country_name || "Unknown";

    renderRegion = `${city}, ${country}`;
    console.log("Detected region:", renderRegion);
  } catch (err) {
    console.warn("IP region lookup failed:", err.message);
    renderRegion = "Lookup Failed";
  }
}

// Call once at startup
await fetchRegionByIP();


// Example endpoint
app.get("/region", (req, res) => {
  res.json({ region: renderRegion });
});




// Validate session token (simplified)
function validateToken(token, sessionId) {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    if (Date.now() > payload.expires) return false;
    if (payload.sessionId !== sessionId) return false;

    return payload;
  } catch {
    return false;
  }
}

// Get client info (no CF headers on Render, so fallback)
function getClientInfo(req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "127.0.0.1";

  return {
    ip,
    country: renderRegion,
    datacenter: renderRegion,
    userAgent: req.headers["user-agent"] || "Unknown",
  };
}

// ------------------- ROUTES ------------------- //

// Health check
app.get("/health", (req, res) => {
  cleanupExpiredSessions();
  res.json({
    status: "healthy",
    version: WORKER_VERSION,
    timestamp: Date.now(),
    uptime: process.uptime(),
    activeSessions: activeSessions.size,
    region: renderRegion,
    datacenter: renderRegion,
    country: "Unknown", // no country info in Render
  });
});

// Connect (session creation)
app.post("/connect", (req, res) => {
  const { token, sessionId, action } = req.body;
  if (action !== "connect" || !token || !sessionId) {
    return res.status(400).json({ error: "Invalid request parameters" });
  }

  const tokenPayload = validateToken(token, sessionId);
  if (!tokenPayload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const clientInfo = getClientInfo(req);
  const session = {
    sessionId,
    created: Date.now(),
    expires: tokenPayload.expires,
    country: tokenPayload.country || "Unknown",
    clientInfo,
    lastActivity: Date.now(),
  };

  activeSessions.set(sessionId, session);

  res.json({
    success: true,
    sessionId,
    ...clientInfo,
    worker: {
      region: renderRegion,
      datacenter: renderRegion,
      version: WORKER_VERSION,
    },
    sessionExpires: new Date(tokenPayload.expires).toISOString(),
  });
});

app.use("/proxy", async (req, res) => {
  try {
    // Extract target URL from query (example: /proxy?url=https://example.com)
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).send("Missing url query param");
    }

    console.log(`Proxying request to: ${targetUrl}`);

    // Forward the request
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: { ...req.headers, host: new URL(targetUrl).host },
      body: req.method !== "GET" && req.method !== "HEAD" ? req : undefined,
    });

    // Pipe response headers
    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    // Stream the response body back to the client
    response.body.pipe(res);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Proxy failed: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
// IP Info
app.get(["/ip", "/info"], (req, res) => {
  const clientInfo = getClientInfo(req);
  res.json({
    ...clientInfo,
    worker: {
      region: renderRegion,
      datacenter: renderRegion,
      version: WORKER_VERSION,
    },
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    service: "PseudoVPN Render",
    version: WORKER_VERSION,
    endpoints: ["/health", "/connect", "/proxy", "/ip"],
    region: renderRegion,
  });
});

// ---------------------------------------------- //

app.listen(PORT, () => {
  console.log(`PseudoVPN server running on port ${PORT}`);
});
