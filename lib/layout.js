"use strict";

const os = require('os');
const { exec } = require('child_process');
const { networkInterfaces } = require('os');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

// --- Configuration ---

/**
 * Finds the package.json file by searching upwards from a starting directory.
 * This is more reliable than using process.cwd().
 * @param {string} startDir The directory to start searching from.
 * @returns {string|null} The full path to package.json or null if not found.
 */
function findPackageJson(startDir) {
    let currentDir = startDir;
    while (true) {
        const packagePath = path.join(currentDir, 'package.json');
        if (fs.existsSync(packagePath)) {
            return packagePath;
        }
        const parentDir = path.dirname(currentDir);
        // If we have reached the root of the file system
        if (parentDir === currentDir) {
            return null;
        }
        currentDir = parentDir;
    }
}

// Start searching from the current script's directory for reliability.
const packagePath = findPackageJson(__dirname);
let currentjinxiedevVersion = 'N/A';
let jinxiedevPackageName = 'unknown-package';

if (packagePath) {
    try {
        const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        currentjinxiedevVersion = packageData.version || 'N/A';
        jinxiedevPackageName = packageData.name || 'unknown-package';
    } catch (error) {
        console.error(`\x1b[31mError reading or parsing package.json at ${packagePath}\x1b[0m`, error);
    }
} else {
    console.warn(`\x1b[33mWarning: Could not find a package.json file.\x1b[0m`);
}


/**
 * A simple promise-based sleep function.
 * @param {number} ms Milliseconds to wait.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Gets super-detailed information for a package from the NPM registry.
 * @param {string} packageName The name of the package.
 * @returns {Promise<object|null>} A detailed object or null if it fails.
 */
async function getNpmPackageDetails(packageName) {
    if (packageName === 'unknown-package') {
        return null;
    }
    try {
        // --- Fetch package metadata and download stats in parallel ---
        const [pkgRes, weeklyDownloadRes] = await Promise.all([
            fetch(`https://registry.npmjs.org/${packageName}`),
            fetch(`https://api.npmjs.org/downloads/point/last-week/${packageName}`)
        ]);

        if (!pkgRes.ok) {
            return null; // Package not found or registry error
        }

        const pkgJson = await pkgRes.json();
        const weeklyDownloadJson = weeklyDownloadRes.ok ? await weeklyDownloadRes.json() : { downloads: 0 };
        
        const latestVersion = pkgJson['dist-tags']?.latest;
        if (!latestVersion) return null;

        const versionData = pkgJson.versions[latestVersion];
        if (!versionData) return null;

        // --- Extract all relevant details ---
        return {
            latestVersion: latestVersion,
            publishTime: pkgJson.time ? new Date(pkgJson.time[latestVersion]) : null,
            license: pkgJson.license || 'N/A',
            homepage: pkgJson.homepage || 'N/A',
            repository: pkgJson.repository?.url.replace(/^git\+/, "").replace(/\.git$/, "") || 'N/A',
            weeklyDownloads: weeklyDownloadJson.downloads || 0,
            unpackedSize: versionData.dist?.unpackedSize || 0,
            dependencies: versionData.dependencies ? Object.keys(versionData.dependencies).length : 0,
        };
    } catch (error) {
        // Handles network errors, etc. by returning null
        return null;
    }
}


/**
 * Displays the animated hacker-style loading sequence.
 */
async function jinxieLoader() {
    return new Promise(resolve => {
        const chars = ["⣿", "⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽"];
        const steps = [
            "Bootstrapping runtime...",
            "Loading cryptography modules...",
            "Initializing sockets & IO...",
            "Scanning network interfaces...",
            "Allocating memory pages...",
            "Calibrating clocks & timers...",
            "Linking native extensions...",
            "Finalizing startup sequence..."
        ];

        let spinner = 0;
        const duration = 3000;
        const interval = 100;
        const frames = Math.floor(duration / interval);
        let frameCount = 0;

        const loadingInterval = setInterval(() => {
            const pct = Math.min(100, Math.floor((frameCount / frames) * 100));
            const barLen = 24;
            const filled = Math.floor((pct / 100) * barLen);
            const bar = `\x1b[32m${"█".repeat(filled)}\x1b[2m${"░".repeat(barLen - filled)}\x1b[0m`;
            const stepMsg = steps[frameCount % steps.length];

            process.stdout.write('\r\x1b[K'); // Clear line
            process.stdout.write(
                `\x1b[36m[\x1b[32m${chars[spinner]}\x1b[36m]\x1b[37m ${stepMsg}  ` +
                `\x1b[90m| ${bar} \x1b[37m${String(pct).padStart(3)}%\x1b[0m`
            );
            spinner = (spinner + 1) % chars.length;
            frameCount++;

            if (frameCount >= frames) {
                clearInterval(loadingInterval);
                process.stdout.write('\r\x1b[K');
                resolve();
            }
        }, interval);
    });
}

/**
 * Formats uptime from seconds to a human-readable string (d h m s).
 * @param {number} uptimeSec Uptime in seconds.
 * @returns {string} Formatted uptime string.
 */
function fmtUptime(uptimeSec) {
    const d = Math.floor(uptimeSec / 86400);
    const h = Math.floor((uptimeSec % 86400) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = Math.floor(uptimeSec % 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h || d) parts.push(`${String(h).padStart(2, '0')}h`);
    if (m || h || d) parts.push(`${String(m).padStart(2, '0')}m`);
    parts.push(`${String(s).padStart(2, '0')}s`);
    return parts.join(' ');
}

/**
 * Converts bytes to a more readable format (KB, MB, GB).
 * @param {number} bytes The number of bytes.
 * @param {number} [decimals=2] The number of decimal places.
 * @returns {string} The formatted string.
 */
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Converts bytes to gigabytes.
 * @param {number} n Number of bytes.
 * @returns {string} String representation of gigabytes, fixed to 2 decimal places.
 */
function bytesToGB(n) {
    return (n / (1024 ** 3)).toFixed(2);
}

/**
 * Gathers and displays system and network information.
 */
async function displaySystemInfo() {
    const interfaces = networkInterfaces();
    const blocks = [];
    let online = false;

    for (const name in interfaces) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                online = true;
                blocks.push(
                    `\x1b[35mInterface:\x1b[37m ${name}\n` +
                    `        \x1b[35mIPv4:\x1b[37m ${iface.address}\n` +
                    (iface.netmask ? `        \x1b[35mNetmask:\x1b[37m ${iface.netmask}\n` : '') +
                    (iface.mac ? `        \x1b[35mMAC:\x1b[37m ${iface.mac}\n` : '')
                );
            }
        }
    }

    // --- Timezone change to WIB (Western Indonesia Time) ---
    const now = new Date();
    const timeZone = 'Asia/Jakarta';
    const currentTime = now.toLocaleString('id-ID', { timeZone: timeZone, hour12: false, dateStyle: 'medium', timeStyle: 'long' });
    const tzDisplay = `${timeZone} (WIB)`;

    const cpus = os.cpus();
    const cpuModel = cpus && cpus.length ? cpus[0].model : 'Unknown CPU';
    const cpuCores = cpus ? cpus.length : 0;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const uptime = os.uptime();    
    // --- Package Version Check (Super De// --- Package Version Check (Super Detailed) ---
const pkgDetails = await getNpmPackageDetails(jinxiedevPackageName);
let packageDetailsInfo;

if (pkgDetails && currentjinxiedevVersion !== 'N/A') {
    let statusLine;
    const versiku = pkgDetails.latestVersion; // definisikan sekali saja di luar if/else

    if (currentjinxiedevVersion === versiku) {
        statusLine = `\x1b[32m✔ Up-to-date\x1b[0m`;
    } else {
        statusLine = `\x1b[33m⚠ Update Tersedia: \x1b[0mv${versiku}`;
    }

    const publishDate = pkgDetails.publishTime
        ? pkgDetails.publishTime.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })
        : 'N/A';

    packageDetailsInfo =
`    \x1b[34m──────────────────────────────────────────────────────────────\x1b[0m
    \x1b[35mPackage:\x1b[37m           ${jinxiedevPackageName}
    \x1b[35mInstalled:\x1b[37m         v${currentjinxiedevVersion}
    \x1b[35mLatest:\x1b[37m            v${versiku}
    \x1b[35mStatus:\x1b[37m            ${statusLine}
    \x1b[35mWeekly Downloads:\x1b[37m  ${pkgDetails.weeklyDownloads.toLocaleString('id-ID')}
    \x1b[35mLast Publish:\x1b[37m      ${publishDate}
    \x1b[35mLicense:\x1b[37m           ${pkgDetails.license}
    \x1b[35mSize (unpacked):\x1b[37m   ${formatBytes(pkgDetails.unpackedSize)}`;
} else {
        packageDetailsInfo = 
`    \x1b[34m──────────────────────────────────────────────────────────────\x1b[0m
    \x1b[35mPackage:\x1b[37m           ${jinxiedevPackageName} (v${currentjinxiedevVersion})
    \x1b[35mStatus:\x1b[37m            \x1b[31m✗ Check failed\x1b[0m`;
    }

    const header = `\x1b[38;5;49m┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓\x1b[0m
\x1b[38;5;49m┃\x1b[0m \x1b[32m[ SYSTEM INFO ]\x1b[0m                                           \x1b[38;5;49m┃\x1b[0m
\x1b[38;5;49m┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\x1b[0m`;

    const sysInfo = `    \x1b[35mOS:\x1b[37m ${os.type()} ${os.release()} (${os.arch()})
    \x1b[35mPlatform:\x1b[37m ${os.platform()}
    \x1b[35mHostname:\x1b[37m ${os.hostname()}
    \x1b[35mNode.js:\x1b[37m ${process.version}
    \x1b[35mCPU:\x1b[37m ${cpuModel} \x1b[90m(${cpuCores} cores)\x1b[37m
    \x1b[35mMemory:\x1b[37m ${bytesToGB(usedMem)} GB used / ${bytesToGB(totalMem)} GB total
    \x1b[35mUptime:\x1b[37m ${fmtUptime(uptime)}
    \x1b[35mCurrent Time:\x1b[37m ${currentTime} \x1b[90m(${tzDisplay})\x1b[0m
${packageDetailsInfo}`;

    const networkStatus = online ? '\x1b[32mOnline\x1b[37m' : '\x1b[31mOffline\x1b[37m';
    const networkInfo = blocks.length ? blocks.map(b => `    ${b}`).join('') : '    \x1b[90mNo external IPv4 interface detected.\x1b[0m';
    const divider = '\x1b[34m──────────────────────────────────────────────────────────────\x1b[0m';

    console.log(`${header}\n${sysInfo}\n${divider}\n    \x1b[35mNetwork Status:\x1b[37m ${networkStatus}\n${networkInfo}${divider}\n`);
}

/**
 * Main function to run the entire visual layout sequence.
 */
async function runLayout() {
    console.clear();
    process.stdout.write('\x1b[?25l'); // Hide cursor

    await jinxieLoader();
    await displaySystemInfo();

    process.stdout.write('\x1b[?25h'); // Show cursor again
    await sleep(500); // Wait a moment for info to be readable
}

module.exports = runLayout;
