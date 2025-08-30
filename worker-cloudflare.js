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
    country: process.env.RENDER_REGION || "Unknown",
    datacenter: process.env.RENDER_REGION || "Unknown",
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
    region: process.env.RENDER_REGION || "Unknown",
    datacenter: process.env.RENDER_REGION || "Unknown",
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
      region: process.env.RENDER_REGION || "Unknown",
      datacenter: process.env.RENDER_REGION || "Unknown",
      version: WORKER_VERSION,
    },
    sessionExpires: new Date(tokenPayload.expires).toISOString(),
  });
});

// Proxy
app.all("/proxy", async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  const token = req.headers["authorization"]?.replace("Bearer ", "");

  if (!sessionId || !token) return res.status(401).send("Unauthorized");

  const session = activeSessions.get(sessionId);
  if (!session || Date.now() > session.expires) {
    activeSessions.delete(sessionId);
    return res.status(401).send("Session expired");
  }

  if (!validateToken(token, sessionId)) {
    return res.status(401).send("Invalid token");
  }

  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Target URL required");

  try {
    session.lastActivity = Date.now();

    const proxyResponse = await fetch(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        "user-agent": "PseudoVPN-Render/1.0",
        "x-forwarded-for": session.clientInfo.ip,
      },
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    res.status(proxyResponse.status);
    proxyResponse.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Proxy-Datacenter", process.env.RENDER_REGION || "Unknown");

    const body = await proxyResponse.buffer();
    res.send(body);
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

// IP Info
app.get(["/ip", "/info"], (req, res) => {
  const clientInfo = getClientInfo(req);
  res.json({
    ...clientInfo,
    worker: {
      region: process.env.RENDER_REGION || "Unknown",
      datacenter: process.env.RENDER_REGION || "Unknown",
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
    region: process.env.RENDER_REGION || "Unknown",
  });
});

// ---------------------------------------------- //

app.listen(PORT, () => {
  console.log(`PseudoVPN server running on port ${PORT}`);
});
