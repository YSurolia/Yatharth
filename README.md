# ⚡ WARFRONT LINK v2.0 — Company Hub

A zero-dependency local network file sharing server. No npm install needed.

## 📁 Folder Structure

```
warfront-link/
├── node_server.js       ← The server (run this)
└── public/
    ├── index.html       ← Web UI
    └── uploads/         ← Uploaded files go here (auto-created)
```

## 🚀 How to Run

1. Make sure **Node.js** is installed (https://nodejs.org)
2. Open **PowerShell** or **Terminal** in this folder
3. Run:

```bash
node node_server.js
```

4. Open in browser:
   - **This PC:** http://localhost:3000
   - **Other devices (phone/tablet/laptop):** http://YOUR_IP:3000

> Your IP is shown in the terminal when the server starts.

## ✅ Features

- 📤 Upload any file (drag & drop or click)
- 📥 Download files from any device on your network
- 🗑️ Delete files
- 🖥️ Shows which device uploaded each file
- 🔄 Auto-refreshes file list every 5 seconds
- 📡 Works on all devices — phone, TV, laptop — no app needed

## ⚙️ Requirements

- Node.js (any version, uses only built-in modules)
- All devices must be on the same Wi-Fi / LAN network

## 🛑 To Stop the Server

Press `Ctrl + C` in the terminal.
