const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');

// Promisified exec for non-blocking calls
function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

// ─── PLATFORM DETECTION ─────────────────────────────────────────────────────
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

// ─── GAME BOOSTER DATA — cross-platform ─────────────────────────────────────
const GAME_DB_WIN = {
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
  'NMS.exe':                            { name: "No Man's Sky" },
  'Terraria.exe':                       { name: 'Terraria' },
  'bg3.exe':                            { name: "Baldur's Gate 3" },
  'Palworld-Win64-Shipping.exe':        { name: 'Palworld' },
};

const GAME_DB_MAC = {
  'java':                 { name: 'Minecraft (Java)' },
  'Minecraft':            { name: 'Minecraft' },
  'FortniteClient':       { name: 'Fortnite' },
  'cs2':                  { name: 'Counter-Strike 2' },
  'RobloxPlayer':         { name: 'Roblox' },
  'Dota 2':               { name: 'Dota 2' },
  'dota2':                { name: 'Dota 2' },
  'League of Legends':    { name: 'League of Legends' },
  'RocketLeague':         { name: 'Rocket League' },
  'Terraria':             { name: 'Terraria' },
  'Baldur':               { name: "Baldur's Gate 3" },
  'bg3':                  { name: "Baldur's Gate 3" },
  'No Man':               { name: "No Man's Sky" },
  'Steam':                { name: 'Steam Game' },
};

const GAME_DB = IS_MAC ? GAME_DB_MAC : GAME_DB_WIN;

const KILLABLE_WIN = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe',
  'Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe',
  'Spotify.exe', 'Teams.exe', 'ms-teams.exe',
  'Slack.exe', 'OneDrive.exe', 'Skype.exe', 'Telegram.exe',
  'WhatsApp.exe', 'Zoom.exe', 'YourPhone.exe', 'PhoneExperienceHost.exe',
  'GameBar.exe', 'GameBarPresenceWriter.exe',
  'CalculatorApp.exe', 'Microsoft.Photos.exe',
  'SnippingTool.exe', 'msteams.exe',
]);

const KILLABLE_MAC = new Set([
  'Google Chrome', 'Google Chrome Helper', 'Firefox', 'Safari',
  'Microsoft Edge', 'Opera', 'Brave Browser',
  'Discord', 'Spotify', 'Microsoft Teams', 'Slack',
  'Skype', 'Telegram', 'WhatsApp', 'zoom.us',
  'OneDrive', 'Dropbox', 'Photos', 'Preview',
  'Notes', 'Reminders', 'Calendar', 'Mail',
]);

const KILLABLE_PROCESSES = IS_MAC ? KILLABLE_MAC : KILLABLE_WIN;

const SAFE_WIN = new Set([
  'System', 'svchost.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'lsass.exe', 'services.exe', 'smss.exe', 'dwm.exe', 'explorer.exe',
  'spoolsv.exe', 'taskhostw.exe', 'RuntimeBroker.exe', 'node.exe',
  'conhost.exe', 'sihost.exe', 'fontdrvhost.exe', 'SearchHost.exe',
  'ctfmon.exe', 'dllhost.exe', 'SecurityHealthService.exe',
  'MsMpEng.exe', 'NisSrv.exe', 'audiodg.exe', 'cmd.exe',
  'powershell.exe', 'WindowsTerminal.exe', 'ShellExperienceHost.exe',
  'StartMenuExperienceHost.exe', 'TextInputHost.exe',
  'electron.exe', 'Game Booster.exe',
]);

const SAFE_MAC = new Set([
  'kernel_task', 'launchd', 'WindowServer', 'loginwindow', 'Finder',
  'Dock', 'SystemUIServer', 'mds', 'mds_stores', 'mdworker',
  'cfprefsd', 'coreaudiod', 'coreservicesd', 'distnoted',
  'UserEventAgent', 'logd', 'opendirectoryd', 'syslogd',
  'node', 'Electron', 'Game Booster',
]);

const SAFE_PROCESSES = IS_MAC ? SAFE_MAC : SAFE_WIN;

const LAUNCHER_WIN = new Set([
  'steam.exe', 'steamwebhelper.exe', 'steamservice.exe',
  'EpicGamesLauncher.exe', 'EpicWebHelper.exe',
  'Battle.net.exe', 'RiotClientServices.exe', 'RiotClientUx.exe',
  'Origin.exe', 'EADesktop.exe', 'GalaxyClient.exe',
  'UbisoftConnect.exe', 'upc.exe',
]);

const LAUNCHER_MAC = new Set([
  'Steam Helper', 'steamwebhelper', 'steam_osx',
  'Epic Games Launcher', 'Battle.net', 'Riot Client',
  'Origin', 'EA Desktop',
]);

const LAUNCHER_PROCESSES = IS_MAC ? LAUNCHER_MAC : LAUNCHER_WIN;

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

// ─── BOOSTER FUNCTIONS (all async — never blocks UI) ─────────────────────────

async function getSystemStats() {
  try {
    if (IS_MAC) {
      const [memOut, cpuOut] = await Promise.all([
        execAsync('vm_stat'),
        execAsync("top -l 1 -n 0 | grep 'CPU usage'").catch(() => ''),
      ]);
      // Parse vm_stat for memory info
      const pageSize = 16384; // default macOS page size
      const freeMatch = memOut.match(/Pages free:\s+(\d+)/);
      const inactiveMatch = memOut.match(/Pages inactive:\s+(\d+)/);
      const activeMatch = memOut.match(/Pages active:\s+(\d+)/);
      const wiredMatch = memOut.match(/Pages wired down:\s+(\d+)/);
      const specMatch = memOut.match(/Pages speculative:\s+(\d+)/);

      const free = (parseInt(freeMatch?.[1] || 0) + parseInt(inactiveMatch?.[1] || 0)) * pageSize;
      const used = (parseInt(activeMatch?.[1] || 0) + parseInt(wiredMatch?.[1] || 0) + parseInt(specMatch?.[1] || 0)) * pageSize;
      const total = free + used;

      const totalMB = Math.round(total / (1024 * 1024));
      const freeMB = Math.round(free / (1024 * 1024));
      const usedMB = totalMB - freeMB;

      // Parse CPU
      const cpuMatch = cpuOut.match(/(\d+\.\d+)% user/);
      const cpuIdle = cpuOut.match(/(\d+\.\d+)% idle/);
      const cpuUsage = cpuIdle ? Math.round(100 - parseFloat(cpuIdle[1])) : (cpuMatch ? Math.round(parseFloat(cpuMatch[1])) : 0);

      return { cpuUsage, ramTotalMB: totalMB, ramFreeMB: freeMB, ramUsedMB: usedMB };
    } else {
      const [ramOut, cpuOut] = await Promise.all([
        execAsync('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json"'),
        execAsync('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_Processor).LoadPercentage"').catch(() => '0'),
      ]);
      const ram = JSON.parse(ramOut);
      const totalMB = Math.round(ram.TotalVisibleMemorySize / 1024);
      const freeMB = Math.round(ram.FreePhysicalMemory / 1024);
      const usedMB = totalMB - freeMB;
      const cpuUsage = parseInt(cpuOut) || 0;
      return { cpuUsage, ramTotalMB: totalMB, ramFreeMB: freeMB, ramUsedMB: usedMB };
    }
  } catch {
    return { cpuUsage: 0, ramTotalMB: 0, ramFreeMB: 0, ramUsedMB: 0 };
  }
}

async function scanProcesses() {
  try {
    if (IS_MAC) {
      // ps on macOS: PID, RSS (KB), COMMAND
      const output = await execAsync('ps -axo pid=,rss=,comm=');
      const lines = output.split('\n');
      const processes = [];
      const games = [];

      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) continue;
        const pid = parseInt(match[1]);
        const memKB = parseInt(match[2]);
        const fullPath = match[3].trim();
        const name = fullPath.split('/').pop();

        processes.push({ name, pid, memKB });

        // Check game DB - match by process name or partial match
        if (GAME_DB[name]) {
          games.push({ processName: name, pid, memKB, ...GAME_DB[name] });
        } else {
          // Partial matching for macOS app names
          for (const [key, val] of Object.entries(GAME_DB)) {
            if (name.includes(key) || fullPath.includes(key)) {
              games.push({ processName: name, pid, memKB, ...val });
              break;
            }
          }
        }
      }

      return { processes, games };
    } else {
      const output = await execAsync('tasklist /FO CSV /NH');
      const lines = output.split('\n');
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
    }
  } catch {
    return { processes: [], games: [] };
  }
}

async function performScan() {
  const [{ processes, games }, stats] = await Promise.all([
    scanProcesses(),
    getSystemStats(),
  ]);
  const killableRunning = processes.filter(p => KILLABLE_PROCESSES.has(p.name));
  return {
    games,
    stats,
    killableCount: killableRunning.length,
    killableProcesses: killableRunning,
    totalProcesses: processes.length,
  };
}

async function boostGame(gamePid, gameName, options) {
  const preStats = await getSystemStats();
  const killed = [];
  let prioritySet = false;
  let ramFreed = false;
  let effectsDisabled = false;

  if (options.killProcesses) {
    const { processes } = await scanProcesses();
    const killPromises = [];
    for (const proc of processes) {
      if (KILLABLE_PROCESSES.has(proc.name) && proc.pid !== gamePid) {
        const killCmd = IS_MAC ? `kill -9 ${proc.pid}` : `taskkill /PID ${proc.pid} /F`;
        killPromises.push(
          execAsync(killCmd, { timeout: 3000 })
            .then(() => killed.push({ name: proc.name, pid: proc.pid, memKB: proc.memKB }))
            .catch(() => {})
        );
      }
    }
    await Promise.all(killPromises);
  }

  const boostPromises = [];

  if (options.highPriority && gamePid) {
    const priorityCmd = IS_MAC
      ? `renice -n -10 -p ${gamePid}`
      : `wmic process where ProcessId=${gamePid} CALL setpriority 128`;
    boostPromises.push(
      execAsync(priorityCmd, { timeout: 3000 })
        .then(() => { prioritySet = true; })
        .catch(() => {})
    );
  }

  if (options.freeRam) {
    const ramCmd = IS_MAC
      ? 'purge'
      : 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object {$_.WorkingSet64 -gt 0} | ForEach-Object { $_.MinWorkingSet = 1 }"';
    boostPromises.push(
      execAsync(ramCmd, { timeout: 8000 })
        .then(() => { ramFreed = true; })
        .catch(() => {})
    );
  }

  if (options.disableEffects) {
    if (IS_MAC) {
      // Reduce macOS visual effects: reduce transparency + reduce motion
      boostPromises.push(
        execAsync('defaults write com.apple.universalaccess reduceTransparency -bool true', { timeout: 3000 })
          .then(() => { effectsDisabled = true; })
          .catch(() => {}),
        execAsync('defaults write com.apple.universalaccess reduceMotion -bool true', { timeout: 3000 })
          .catch(() => {})
      );
    } else {
      boostPromises.push(
        execAsync("powershell -NoProfile -ExecutionPolicy Bypass -Command \"Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting -Value 2\"", { timeout: 3000 })
          .then(() => { effectsDisabled = true; })
          .catch(() => {})
      );
    }
  }

  await Promise.all(boostPromises);

  const postStats = await getSystemStats();

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

  return {
    success: true,
    killedCount: killed.length,
    killedProcesses: killed,
    prioritySet,
    ramFreed,
    effectsDisabled,
    preStats,
    postStats,
    ramFreedMB: postStats.ramFreeMB - preStats.ramFreeMB,
  };
}

async function unboostGame() {
  const actions = [];
  const promises = [];

  if (boostState.visualEffectsDisabled) {
    if (IS_MAC) {
      promises.push(
        execAsync('defaults write com.apple.universalaccess reduceTransparency -bool false', { timeout: 3000 })
          .then(() => actions.push('Restored visual effects'))
          .catch(() => {}),
        execAsync('defaults write com.apple.universalaccess reduceMotion -bool false', { timeout: 3000 })
          .catch(() => {})
      );
    } else {
      promises.push(
        execAsync("powershell -NoProfile -ExecutionPolicy Bypass -Command \"Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects' -Name VisualFXSetting -Value 0\"", { timeout: 3000 })
          .then(() => actions.push('Restored visual effects'))
          .catch(() => {})
      );
    }
  }

  if (boostState.gamePid) {
    const resetCmd = IS_MAC
      ? `renice -n 0 -p ${boostState.gamePid}`
      : `wmic process where ProcessId=${boostState.gamePid} CALL setpriority 32`;
    promises.push(
      execAsync(resetCmd, { timeout: 3000 })
        .then(() => actions.push('Reset game priority to Normal'))
        .catch(() => {})
    );
  }

  await Promise.all(promises);

  const previouslyKilled = boostState.killedProcesses.map(p => p.name);

  boostState = {
    active: false,
    killedProcesses: [],
    gamePid: null,
    gameName: null,
    visualEffectsDisabled: false,
    preBoostStats: null,
    postBoostStats: null,
    timestamp: null,
  };

  return { success: true, actions, previouslyKilled };
}

// ─── ELECTRON APP ────────────────────────────────────────────────────────────

let mainWindow = null;
let tray = null;
let isQuitting = false;
let scanTimer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 900,
    minWidth: 400,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    title: 'Game Booster',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.removeMenu();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Create a simple 16x16 blue icon programmatically
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
    'dElEQVQ4T2NkoBAwUqifYdAa8B8ZM2ITIA5TbgAjIyMDEwMDgwQDA8N/BgaG/wwMDP+J' +
    'cQUTAwMDMwMDgyQDA4MEAwPDfwYGhv8kGcDEwMDAzMDAIMnAwCBBigEsQC+QZIA4AwOD' +
    'OAMDgzgxBoyKBmIjCQBJuSARMuNL0AAAAABJRU5ErkJggg=='
  );
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Game Booster', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip('Game Booster');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

let scanning = false;
function startAutoScan() {
  scanTimer = setInterval(async () => {
    if (scanning || !mainWindow || mainWindow.isDestroyed()) return;
    scanning = true;
    try {
      const data = await performScan();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('booster:scan-update', data);
      }
    } catch {}
    scanning = false;
  }, 5000);
}

// ─── IPC HANDLERS ────────────────────────────────────────────────────────────

ipcMain.handle('booster:scan', async () => {
  return performScan();
});

ipcMain.handle('booster:boost', async (_event, { gamePid, gameName, options }) => {
  return boostGame(gamePid, gameName, options);
});

ipcMain.handle('booster:unboost', async () => {
  return unboostGame();
});

ipcMain.handle('booster:status', async () => {
  return boostState;
});

// ─── APP LIFECYCLE ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createTray();
  startAutoScan();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (scanTimer) clearInterval(scanTimer);
});

app.on('window-all-closed', () => {
  // Do nothing — tray keeps the app alive
});
