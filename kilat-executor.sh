#!/bin/bash

#############################################
# KilatExecutor VPS - One-Line Deploy Script
#############################################
#
# Deploy with:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/main/deploy/kilat-executor.sh | bash
#
# Or run locally:
#   chmod +x kilat-executor.sh && ./kilat-executor.sh
#
# Requirements:
#   - Ubuntu/Debian VPS (1GB RAM minimum)
#   - Root or sudo access
#
#############################################

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}"
echo "╔════════════════════════════════════════════════╗"
echo "║     KilatExecutor VPS - Quick Deploy           ║"
echo "║     One-Line Install for Code Execution        ║"
echo "╚════════════════════════════════════════════════╝"
echo -e "${NC}"

# Configuration
INSTALL_DIR="/opt/kilat-executor"
SERVICE_NAME="kilat-executor"
PORT="${KILAT_PORT:-3002}"  # Port 3001 used by Playwright!
GITHUB_RAW="https://raw.githubusercontent.com/matiloanjing/Kilat-Tutor/main"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${YELLOW}⚠️  Please run as root or with sudo${NC}"
    exit 1
fi

echo -e "${GREEN}[1/6]${NC} Installing dependencies..."

# Update and install Node.js if not present
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Install other runtime dependencies
apt-get update -qq
apt-get install -y -qq python3 python3-pip

# Optional: Install other languages
echo -e "${YELLOW}Installing optional language runtimes...${NC}"
apt-get install -y -qq golang-go 2>/dev/null || echo "Go not available"
apt-get install -y -qq php 2>/dev/null || echo "PHP not available"

echo -e "${GREEN}[2/6]${NC} Creating install directory..."
mkdir -p $INSTALL_DIR
cd $INSTALL_DIR

echo -e "${GREEN}[3/6]${NC} Downloading executor server..."

# Download server file
curl -fsSL "$GITHUB_RAW/vps-executor-server.js" -o server.js 2>/dev/null || {
    echo -e "${YELLOW}GitHub download failed, using embedded version...${NC}"
    cat > server.js << 'SERVEREOF'
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

const CONFIG = {
    PORT: process.env.PORT || 3001,
    MAX_TIMEOUT: 60000,
    MAX_CODE_SIZE: 100000,
    TEMP_DIR: path.join(os.tmpdir(), 'kilat-executor'),
    LANGUAGES: {
        javascript: { extension: '.js', command: 'node', args: [] },
        typescript: { extension: '.ts', command: 'npx', args: ['tsx'] },
        python: { extension: '.py', command: 'python3', args: [] },
        go: { extension: '.go', command: 'go', args: ['run'] },
        php: { extension: '.php', command: 'php', args: [] }
    }
};

fs.mkdir(CONFIG.TEMP_DIR, { recursive: true }).catch(() => {});

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: 'KilatExecutor', uptime: process.uptime() });
});

app.get('/languages', (req, res) => {
    res.json({ languages: Object.keys(CONFIG.LANGUAGES) });
});

app.post('/execute', async (req, res) => {
    const { code, language, stdin = '', timeout = 30000 } = req.body;
    const startTime = Date.now();
    
    if (!code || !language) {
        return res.status(400).json({ success: false, error: 'Missing code/language' });
    }
    
    const langConfig = CONFIG.LANGUAGES[language];
    if (!langConfig) {
        return res.status(400).json({ success: false, error: 'Unsupported language' });
    }
    
    try {
        const jobId = crypto.randomUUID();
        const tempDir = path.join(CONFIG.TEMP_DIR, jobId);
        await fs.mkdir(tempDir, { recursive: true });
        
        const filename = 'main' + langConfig.extension;
        const filepath = path.join(tempDir, filename);
        await fs.writeFile(filepath, code);
        
        const result = await new Promise((resolve, reject) => {
            let stdout = '', stderr = '';
            const proc = spawn(langConfig.command, [...langConfig.args, filepath], { 
                cwd: tempDir, timeout: Math.min(timeout, CONFIG.MAX_TIMEOUT) 
            });
            
            proc.stdout.on('data', d => stdout += d);
            proc.stderr.on('data', d => stderr += d);
            proc.on('close', code => resolve({ stdout, stderr, exitCode: code }));
            proc.on('error', reject);
        });
        
        fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        
        res.json({
            success: result.exitCode === 0,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            executionTime: Date.now() - startTime
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(CONFIG.PORT, () => {
    console.log('KilatExecutor VPS running on port', CONFIG.PORT);
});
SERVEREOF
}

echo -e "${GREEN}[4/6]${NC} Installing npm packages..."
npm init -y > /dev/null 2>&1
npm install express tsx > /dev/null 2>&1

echo -e "${GREEN}[5/6]${NC} Creating systemd service..."
cat > /etc/systemd/system/$SERVICE_NAME.service << EOF
[Unit]
Description=KilatExecutor VPS Code Execution Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=PORT=$PORT
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}[6/6]${NC} Starting service..."
systemctl daemon-reload
systemctl enable $SERVICE_NAME
systemctl restart $SERVICE_NAME

# Wait for service to start
sleep 2

# Check status
if systemctl is-active --quiet $SERVICE_NAME; then
    echo -e "${GREEN}"
    echo "╔════════════════════════════════════════════════╗"
    echo "║    ✅ KilatExecutor VPS - INSTALLED!           ║"
    echo "╠════════════════════════════════════════════════╣"
    echo "║  Status: RUNNING                               ║"
    echo "║  Port:   $PORT                                 ║"
    echo "║  Path:   $INSTALL_DIR                          ║"
    echo "╚════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo "Commands:"
    echo "  systemctl status $SERVICE_NAME    # Check status"
    echo "  systemctl restart $SERVICE_NAME   # Restart"
    echo "  journalctl -u $SERVICE_NAME -f    # View logs"
    echo ""
    echo "Test:"
    echo "  curl http://localhost:$PORT/health"
    echo ""
    echo "Update KilatTutor .env:"
    echo "  VPS_EXECUTOR_URL=http://YOUR_VPS_IP:$PORT"
    echo ""
else
    echo -e "${RED}❌ Service failed to start. Check logs:${NC}"
    echo "  journalctl -u $SERVICE_NAME -n 50"
fi
