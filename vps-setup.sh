#!/bin/bash
##############################################
# KilatCrawl Heavy Mode - VPS Setup Script
# For: Ubuntu 22.04 LTS (1GB RAM minimum)
# Copyright © 2025 KilatCode Studio
##############################################

set -e  # Exit on error

echo "🚀 KilatCrawl VPS Setup - Ubuntu 22.04"
echo "======================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo -e "${RED}❌ Please run as root (sudo)${NC}"
    exit 1
fi

# 1. System Check
echo -e "${BLUE}📊 Checking system resources...${NC}"
TOTAL_RAM=$(free -m | awk '/^Mem:/{print $2}')
echo "   RAM: ${TOTAL_RAM}MB"
if [ "$TOTAL_RAM" -lt 900 ]; then
    echo -e "${RED}⚠️  Warning: Less than 1GB RAM detected. Playwright may be unstable.${NC}"
fi
echo ""

# 2. Update system
echo -e "${BLUE}📦 Updating system packages...${NC}"
apt-get update -qq
apt-get upgrade -y -qq
echo -e "${GREEN}✅ System updated${NC}"
echo ""

# 3. Install Node.js 18
echo -e "${BLUE}📦 Installing Node.js 18...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
    echo -e "${GREEN}✅ Node.js $(node -v) installed${NC}"
else
    echo -e "${GREEN}✅ Node.js $(node -v) already installed${NC}"
fi
echo ""

# 4. Install Chromium (for Playwright)
echo -e "${BLUE}📦 Installing Chromium browser...${NC}"
apt-get install -y chromium-browser
echo -e "${GREEN}✅ Chromium installed${NC}"
echo ""

# 5. Install dependencies for Playwright
echo -e "${BLUE}📦 Installing Playwright dependencies...${NC}"
apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2
echo -e "${GREEN}✅ Playwright dependencies installed${NC}"
echo ""

# 6. Install PM2 (process manager)
echo -e "${BLUE}📦 Installing PM2...${NC}"
npm install -g pm2
echo -e "${GREEN}✅ PM2 installed${NC}"
echo ""

# 7. Create app directory
echo -e "${BLUE}📁 Creating app directory...${NC}"
mkdir -p /opt/kilatcrawl
cd /opt/kilatcrawl
echo -e "${GREEN}✅ Directory created: /opt/kilatcrawl${NC}"
echo ""

# 8. Create minimal package.json
echo -e "${BLUE}📄 Creating package.json...${NC}"
cat > package.json << 'EOF'
{
  "name": "kilatcrawl-heavy",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "playwright": "^1.40.0",
    "express": "^4.18.2"
  }
}
EOF
echo -e "${GREEN}✅ package.json created${NC}"
echo ""

# 9. Install npm packages
echo -e "${BLUE}📦 Installing npm packages...${NC}"
npm install --production
echo -e "${GREEN}✅ Packages installed${NC}"
echo ""

# 10. Create server script
echo -e "${BLUE}📄 Creating server.js...${NC}"
cat > server.js << 'EOF'
import { chromium } from 'playwright';
import express from 'express';

const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', mode: 'heavy', memory: process.memoryUsage() });
});

// Crawl endpoint
app.post('/crawl', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    let browser;
    try {
        console.log(`Crawling: ${url}`);
        
        // Launch browser with memory optimization
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ]
        });

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        
        const html = await page.content();
        const title = await page.title();
        
        await browser.close();
        
        res.json({
            success: true,
            url,
            title,
            html: html.substring(0, 10000), // Limit size
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🎭 KilatCrawl Heavy Mode running on port ${PORT}`);
});
EOF
echo -e "${GREEN}✅ server.js created${NC}"
echo ""

# 11. Create PM2 ecosystem file
echo -e "${BLUE}📄 Creating PM2 config...${NC}"
cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'kilatcrawl-heavy',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '800M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    }
  }]
};
EOF
echo -e "${GREEN}✅ PM2 config created${NC}"
echo ""

# 12. Start service
echo -e "${BLUE}🚀 Starting KilatCrawl service...${NC}"
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
echo -e "${GREEN}✅ Service started${NC}"
echo ""

# 13. Setup firewall (optional)
echo -e "${BLUE}🔥 Configuring firewall...${NC}"
if command -v ufw &> /dev/null; then
    ufw allow 3001/tcp
    echo -e "${GREEN}✅ Firewall configured (port 3001)${NC}"
else
    echo -e "${BLUE}ℹ️  UFW not found, skipping firewall${NC}"
fi
echo ""

# 14. Final check
echo -e "${BLUE}🧪 Testing service...${NC}"
sleep 2
curl -s http://localhost:3001/health | jq . || echo "Service started (jq not installed for pretty print)"
echo ""

# Summary
echo ""
echo "======================================"
echo -e "${GREEN}✅ SETUP COMPLETE!${NC}"
echo "======================================"
echo ""
echo "Service Info:"
echo "  - Status: $(pm2 status | grep kilatcrawl-heavy)"
echo "  - Port: 3001"
echo "  - Endpoint: http://YOUR_VPS_IP:3001/crawl"
echo ""
echo "Usage:"
echo "  pm2 status           - Check status"
echo "  pm2 logs             - View logs"
echo "  pm2 restart all      - Restart service"
echo "  pm2 stop all         - Stop service"
echo ""
echo "Test:"
echo '  curl -X POST http://localhost:3001/crawl \\'
echo '    -H "Content-Type: application/json" \\'
echo '    -d '"'"'{"url":"https://example.com"}'"'"
echo ""
echo -e "${GREEN}🎉 KilatCrawl Heavy Mode is ready!${NC}"
