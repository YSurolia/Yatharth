const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── GAME BOOSTER ────────────────────────────────────────────────────────────
const GAME_DB = {
  'javaw.exe':                          { name: 'Minecraft (Java)' },
  'Minecraft.Windows.exe':              { name: 'Minecraft (Bedrock)' },
  'FortniteClient-Win64-Shipping.exe':  { name: 'Fortnite' },
  'VALORANT-Win64-Shipping.exe':        { name: 'Valorant' },
  'cs2.exe':                            { name: 'Counter-Strike 2' },
  'RobloxPlayerBeta.exe':               { name: 'Roblox' },
  'GTA5.exe':                           { name: 'GTA V' },
  'r5apex.exe':                         { name: 'Apex Legends' },
  'overwatch.exe':                      { name: 'Overwatch 2' },
  'LeagueOfLegends.exe':                { name: 'League of Legends' },
  'RocketLeague.exe':                   { name: 'Rocket League' },
  'eldenring.exe':                      { name: 'Elden Ring' },
  'Cyberpunk2077.exe':                  { name: 'Cyberpunk 2077' },
  'destiny2.exe':                       { name: 'Destiny 2' },
  'PUBG-Win64-Shipping.exe':            { name: 'PUBG' },
  'RainbowSix.exe':                     { name: 'Rainbow Six Siege' },
  'Warzone.exe':                        { name: 'Call of Duty: Warzone' },
  'cod.exe':                            { name: 'Call of Duty' },
  'dota2.exe':                          { name: 'Dota 2' },
  'FiveM.exe':                          { name: 'FiveM (GTA RP)' },
  'NMS.exe':                            { name: 'No Man\'s Sky' },
  'Terraria.exe':                       { name: 'Terraria' },
  'bg3.exe':                            { name: 'Baldur\'s Gate 3' },
  'Palworld-Win64-Shipping.exe':        { name: 'Palworld' },
};

const KILLABLE_PROCESSES = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe',
  'Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe',
  'Spotify.exe', 'Teams.exe', 'ms-teams.exe',
  'Slack.exe', 'OneDrive.exe', 'Skype.exe', 'Telegram.exe',
  'WhatsApp.exe', 'Zoom.exe', 'YourPhone.exe', 'PhoneExperienceHost.exe',
  'GameBar.exe', 'GameBarPresenceWriter.exe',
  'CalculatorApp.exe', 'Microsoft.Photos.exe',
  'SnippingTool.exe', 'msteams.exe',
]);

const SAFE_PROCESSES = new Set([
  'System', 'svchost.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'lsass.exe', 'services.exe', 'smss.exe', 'dwm.exe', 'explorer.exe',
  'spoolsv.exe', 'taskhostw.exe', 'RuntimeBroker.exe', 'node.exe',
  'conhost.exe', 'sihost.exe', 'fontdrvhost.exe', 'SearchHost.exe',
  'ctfmon.exe', 'dllhost.exe', 'SecurityHealthService.exe',
  'MsMpEng.exe', 'NisSrv.exe', 'audiodg.exe', 'cmd.exe',
  'powershell.exe', 'WindowsTerminal.exe', 'ShellExperienceHost.exe',
  'StartMenuExperienceHost.exe', 'TextInputHost.exe',
]);

const LAUNCHER_PROCESSES = new Set([
  'steam.exe', 'steamwebhelper.exe', 'steamservice.exe',
  'EpicGamesLauncher.exe', 'EpicWebHelper.exe',
  'Battle.net.exe', 'RiotClientServices.exe', 'RiotClientUx.exe',
  'Origin.exe', 'EADesktop.exe', 'GalaxyClient.exe',
  'UbisoftConnect.exe', 'upc.exe',
]);

let boostState = {
  active: false,
  killedProcesses: [],
  gamePid: null,
  gameName: null,
  visualEffectsDisabled: false,
  preBoostStats: null,
  postBoostStats: null,
  timestamp: null,
};

function getSystemStats() {
  try {
    const ramOut = execSync(
      'powershell -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json"',
      { timeout: 5000 }
    ).toString().trim();
    const ram = JSON.parse(ramOut);
    const totalMB = Math.round(ram.TotalVisibleMemorySize / 1024);
    const freeMB = Math.round(ram.FreePhysicalMemory / 1024);
    const usedMB = totalMB - freeMB;

    let cpuUsage = 0;
    try {
      const cpuOut = execSync(
        'powershell -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Processor).LoadPercentage"',
        { timeout: 5000 }
      ).toString().trim();
      cpuUsage = parseInt(cpuOut) || 0;
    } catch {}

    return { cpuUsage, ramTotalMB: totalMB, ramFreeMB: freeMB, ramUsedMB: usedMB };
  } catch (e) {
    return { cpuUsage: 0, ramTotalMB: 0, ramFreeMB: 0, ramUsedMB: 0 };
  }
}

function scanProcesses() {
  try {
    const output = execSync('tasklist /FO CSV /NH', { timeout: 5000 }).toString();
    const lines = output.trim().split('\n');
    const processes = [];
    const games = [];

    for (const line of lines) {
      const match = line.match(/"([^"]+)","(\d+)","[^"]*","[^"]*","([^"]+)"/);
      if (!match) continue;
      const [, name, pid, mem] = match;
      const memKB = parseInt(mem.replace(/[^0-9]/g, '')) || 0;
      processes.push({ name, pid: parseInt(pid), memKB });

      if (GAME_DB[name]) {
        games.push({ processName: name, pid: parseInt(pid), memKB, ...GAME_DB[name] });
      }
    }

    return { processes, games };
  } catch {
    return { processes: [], games: [] };
  }
}

// ─── SSE & PRESENCE ──────────────────────────────────────────────────────────
const sseClients = new Map();  // userId -> { res, deviceName }

function sseSend(userId, event, data) {
  const client = sseClients.get(userId);
  if (!client) return false;
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

function sseBroadcast(event, data, excludeId) {
  for (const [id, client] of sseClients) {
    if (id !== excludeId) {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
}

function getOnlineUsers(excludeId) {
  const users = [];
  for (const [id, client] of sseClients) {
    if (id !== excludeId) {
      users.push({ id, name: client.deviceName });
    }
  }
  return users;
}

// ─── JSON BODY PARSER ────────────────────────────────────────────────────────
function parseJSON(req, callback) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      callback(null, JSON.parse(Buffer.concat(chunks).toString()));
    } catch (e) {
      callback(e);
    }
  });
  req.on("error", callback);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function getMime(ext) {
  const map = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return map[ext] || "application/octet-stream";
}

// ─── MULTIPART PARSER ─────────────────────────────────────────────────────────
function parseMultipart(req, callback) {
  const boundary = req.headers["content-type"]
    ?.split("boundary=")[1]
    ?.trim();
  if (!boundary) return callback(new Error("No boundary"), null);

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const sep = Buffer.from("--" + boundary);
    const parts = [];
    let start = 0;

    for (let i = 0; i < body.length; i++) {
      if (body.slice(i, i + sep.length).equals(sep)) {
        if (start > 0) parts.push(body.slice(start, i - 2));
        start = i + sep.length + 2;
      }
    }

    const files = [];
    let deviceName = "UnknownDevice";

    for (const part of parts) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toString();
      const content = part.slice(headerEnd + 4);

      const nameMatch = headers.match(/name="([^"]+)"/);
      const fileMatch = headers.match(/filename="([^"]+)"/);

      if (nameMatch && nameMatch[1] === "device") {
        deviceName = content.toString().trim();
      }

      if (fileMatch) {
        const filename = fileMatch[1];
        if (!filename) continue;
        const safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
        const dest = path.join(UPLOAD_DIR, safe);
        fs.writeFileSync(dest, content);
        files.push({ name: safe, size: content.length });
      }
    }

    callback(null, { files, deviceName });
  });

  req.on("error", callback);
}

// ─── FILE LIST API ─────────────────────────────────────────────────────────────
function getFileList() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR).map((name) => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, name));
    return { name, size: stat.size, time: stat.mtimeMs };
  }).sort((a, b) => b.time - a.time);
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // ── SSE endpoint ──
  if (req.method === "GET" && pathname === "/sse") {
    const userId = url.searchParams.get("id");
    const deviceName = decodeURIComponent(url.searchParams.get("name") || "Unknown");

    if (!userId) {
      res.writeHead(400).end("Missing id");
      return;
    }

    // Close existing connection for this userId if any
    if (sseClients.has(userId)) {
      try { sseClients.get(userId).res.end(); } catch {}
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ id: userId })}\n\n`);

    sseClients.set(userId, { res, deviceName });

    console.log(`\x1b[32m📡 User connected: ${deviceName} (${userId.slice(0, 8)}...)\x1b[0m`);

    // Broadcast join to others
    sseBroadcast("user-joined", { userId, name: deviceName }, userId);

    req.on("close", () => {
      sseClients.delete(userId);
      console.log(`\x1b[90m📡 User disconnected: ${deviceName}\x1b[0m`);
      sseBroadcast("user-left", { userId, name: deviceName });
    });

    return;
  }

  // ── Online users ──
  if (req.method === "GET" && pathname === "/online-users") {
    const excludeId = url.searchParams.get("exclude") || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getOnlineUsers(excludeId)));
    return;
  }

  // ── Signaling relay ──
  if (req.method === "POST" && pathname === "/signal") {
    parseJSON(req, (err, data) => {
      if (err || !data || !data.to || !data.from || !data.type) {
        res.writeHead(400).end("Invalid signal");
        return;
      }
      const sent = sseSend(data.to, data.type, {
        from: data.from,
        payload: data.payload || {},
      });
      if (sent) {
        res.writeHead(200).end("ok");
      } else {
        res.writeHead(404).end("User offline");
      }
    });
    return;
  }

  // API: upload
  if (req.method === "POST" && pathname === "/upload") {
    parseMultipart(req, (err, result) => {
      if (err || !result || result.files.length === 0) {
        res.writeHead(400).end("Upload failed");
        return;
      }
      result.files.forEach((f) => {
        console.log(
          `\x1b[33m📁 File uploaded: ${f.name} (${formatSize(f.size)}) by ${result.deviceName}\x1b[0m`
        );
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, files: result.files }));
    });
    return;
  }

  // API: file list
  if (req.method === "GET" && pathname === "/files") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getFileList()));
    return;
  }

  // API: delete file
  if (req.method === "DELETE" && pathname.startsWith("/files/")) {
    const name = decodeURIComponent(pathname.slice(7));
    const safe = path.basename(name);
    const filePath = path.join(UPLOAD_DIR, safe);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`\x1b[31m🗑  File deleted: ${safe}\x1b[0m`);
      res.writeHead(200).end("ok");
    } else {
      res.writeHead(404).end("not found");
    }
    return;
  }

  // ── Game Booster: Scan ──
  if (req.method === "GET" && pathname === "/api/booster/scan") {
    const { processes, games } = scanProcesses();
    const stats = getSystemStats();
    const killableRunning = processes.filter(p => KILLABLE_PROCESSES.has(p.name));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ games, stats, killableCount: killableRunning.length, killableProcesses: killableRunning, totalProcesses: processes.length }));
    return;
  }

  // ── Game Booster: Boost ──
  if (req.method === "POST" && pathname === "/api/booster/boost") {
    parseJSON(req, (err, data) => {
      if (err || !data) {
        res.writeHead(400).end("Invalid request");
        return;
      }
      const { gamePid, gameName, options } = data;
      const preStats = getSystemStats();
      const killed = [];
      let prioritySet = false;
      let ramFreed = false;
      let effectsDisabled = false;

      // Kill background processes
      if (options.killProcesses) {
        const { processes } = scanProcesses();
        for (const proc of processes) {
          if (KILLABLE_PROCESSES.has(proc.name) && proc.pid !== gamePid) {
            try {
              execSync(`taskkill /PID ${proc.pid} /F`, { timeout: 3000, stdio: 'ignore' });
              killed.push({ name: proc.name, pid: proc.pid, memKB: proc.memKB });
            } catch {}
          }
        }
      }

      // Set game to high priority
      if (options.highPriority && gamePid) {
        try {
          execSync(`wmic process where ProcessId=${gamePid} CALL setpriority 128`, { timeout: 3000, stdio: 'ignore' });
          prioritySet = true;
        } catch {}
      }

      // Free RAM
      if (options.freeRam) {
        try {
          execSync('powershell -ExecutionPolicy Bypass -Command "Get-Process | Where-Object {$_.WorkingSet64 -gt 0} | ForEach-Object { $_.MinWorkingSet = 1 }"', { timeout: 8000, stdio: 'ignore' });
          ramFreed = true;
        } catch {}
      }

      // Disable visual effects
      if (options.disableEffects) {
        try {
          execSync('powershell -ExecutionPolicy Bypass -Command "Set-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects\' -Name VisualFXSetting -Value 2"', { timeout: 3000, stdio: 'ignore' });
          effectsDisabled = true;
        } catch {}
      }

      const postStats = getSystemStats();

      boostState = {
        active: true,
        killedProcesses: killed,
        gamePid,
        gameName: gameName || 'Unknown Game',
        visualEffectsDisabled: effectsDisabled,
        preBoostStats: preStats,
        postBoostStats: postStats,
        timestamp: Date.now(),
      };

      console.log(`\x1b[35m🚀 Game Boost activated for ${gameName} — killed ${killed.length} processes\x1b[0m`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        killedCount: killed.length,
        killedProcesses: killed,
        prioritySet,
        ramFreed,
        effectsDisabled,
        preStats,
        postStats,
        ramFreedMB: postStats.ramFreeMB - preStats.ramFreeMB,
      }));
    });
    return;
  }

  // ── Game Booster: Unboost ──
  if (req.method === "POST" && pathname === "/api/booster/unboost") {
    const actions = [];

    if (boostState.visualEffectsDisabled) {
      try {
        execSync('powershell -ExecutionPolicy Bypass -Command "Set-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects\' -Name VisualFXSetting -Value 0"', { timeout: 3000, stdio: 'ignore' });
        actions.push('Restored visual effects');
      } catch {}
    }

    if (boostState.gamePid) {
      try {
        execSync(`wmic process where ProcessId=${boostState.gamePid} CALL setpriority 32`, { timeout: 3000, stdio: 'ignore' });
        actions.push('Reset game priority to Normal');
      } catch {}
    }

    const previouslyKilled = boostState.killedProcesses.map(p => p.name);
    console.log(`\x1b[33m🔄 Game Boost deactivated — restored ${actions.length} settings\x1b[0m`);

    boostState = { active: false, killedProcesses: [], gamePid: null, gameName: null, visualEffectsDisabled: false, preBoostStats: null, postBoostStats: null, timestamp: null };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, actions, previouslyKilled }));
    return;
  }

  // ── Game Booster: Status ──
  if (req.method === "GET" && pathname === "/api/booster/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(boostState));
    return;
  }

  // ── Game Booster Installer Download ──
  if (req.method === "GET" && pathname === "/download-installer") {
    const installerPath = path.join(__dirname, "game-booster-app", "dist", "Game Booster Setup 1.0.0.exe");
    if (fs.existsSync(installerPath)) {
      const stat = fs.statSync(installerPath);
      res.writeHead(200, {
        "Content-Disposition": 'attachment; filename="Game Booster Setup 1.0.0.exe"',
        "Content-Type": "application/octet-stream",
        "Content-Length": stat.size,
      });
      fs.createReadStream(installerPath).pipe(res);
    } else {
      res.writeHead(404).end("Installer not found");
    }
    return;
  }

  // Download uploaded file
  if (req.method === "GET" && pathname.startsWith("/uploads/")) {
    const name = decodeURIComponent(pathname.slice(9));
    const safe = path.basename(name);
    const filePath = path.join(UPLOAD_DIR, safe);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, {
        "Content-Disposition": `attachment; filename="${safe}"`,
        "Content-Type": "application/octet-stream",
      });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404).end("Not found");
    }
    return;
  }

  // Serve static files
  let filePath =
    pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": getMime(ext) });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404).end("Not found");
  }
});

// ─── SSE KEEPALIVE ───────────────────────────────────────────────────────────
setInterval(() => {
  for (const [id, client] of sseClients) {
    try {
      client.res.write(`:keepalive\n\n`);
    } catch {
      sseClients.delete(id);
    }
  }
}, 15000);

server.listen(PORT, "0.0.0.0", () => {
  const localIP = getLocalIP();
  const pc = os.hostname();
  console.log("\x1b[36m" + "═".repeat(52) + "\x1b[0m");
  console.log("\x1b[1m\x1b[33m  ⚡ WARFRONT LINK v2.0 — Company Hub\x1b[0m");
  console.log("\x1b[36m" + "═".repeat(52) + "\x1b[0m");
  console.log(`\x1b[32m  ✓ Server running on port \x1b[1m${PORT}\x1b[0m`);
  console.log(`\x1b[31m  📌 Open on THIS PC:\x1b[0m`);
  console.log(`\x1b[34m     http://localhost:${PORT}\x1b[0m`);
  console.log(`\x1b[35m  🖥  Open on OTHER DEVICES (phone/TV/laptop):\x1b[0m`);
  console.log(`\x1b[34m     http://${localIP}:${PORT}\x1b[0m`);
  console.log(`\x1b[90m  All devices auto-connect. No setup needed.\x1b[0m`);
  console.log("\x1b[36m" + "═".repeat(52) + "\x1b[0m");
});
