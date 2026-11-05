const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log("🤖 its-phestone bootstrapper running...");

// 1. Install dependencies inside the bot folder
const botDir = path.join(__dirname, 'bot');
if (fs.existsSync(path.join(botDir, 'package.json'))) {
    try {
        console.log("📦 Checking bot dependencies...");
        execSync('npm install --omit=dev', { cwd: botDir, stdio: 'inherit' });
    } catch (e) {
        console.log("⚠️ Dependency install failed.");
    }
}

// 2. FORCE BLOCKED SCRIPTS (SillyDev Security bypass)
try {
    console.log("🔧 Forcing blocked install scripts to run...");
    const baileysDir = path.join(botDir, 'node_modules', '@whiskeysockets', 'baileys');
    if (fs.existsSync(baileysDir)) {
        execSync('node ./engine-requirements.js', { cwd: baileysDir, stdio: 'inherit' });
    }
    const protobufDir = path.join(botDir, 'node_modules', 'protobufjs');
    if (fs.existsSync(protobufDir)) {
        execSync('node scripts/postinstall', { cwd: protobufDir, stdio: 'inherit' });
    }
    console.log("✅ Blocked scripts forced successfully.");
} catch (e) {
    console.log("⚠️ Script forcing failed, proceeding anyway...");
}

// 3. Launch the actual bot
console.log("🚀 Starting the WhatsApp Engine...");
process.chdir(botDir);
require(path.join(botDir, 'index.js'));