/**
 * MusicFlow — Pre-build Binary Installer
 * Ensures yt-dlp binary is downloaded and executable for Cloud Deployment (Render, Railway, Koyeb, Docker, VPS)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

async function prepareBinaries() {
  console.log('\n[MusicFlow Build] 🛠️ Preparing background stream binaries for cloud deployment...');

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const binaryName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const binaryPath = path.join(__dirname, binaryName);

  // 1. Check if binary already exists locally
  if (fs.existsSync(binaryPath)) {
    console.log(`[MusicFlow Build] ✅ Found existing yt-dlp binary at: ${binaryPath}`);
    if (!isWin) {
      try { fs.chmodSync(binaryPath, '755'); } catch (e) {}
    }
    return;
  }

  // 2. Check if yt-dlp is in system PATH
  try {
    const version = execSync('yt-dlp --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (version) {
      console.log(`[MusicFlow Build] ✅ System yt-dlp found in PATH (version: ${version})`);
      return;
    }
  } catch (e) {
    // Not in PATH, download below
  }

  // 3. Download official binary for current platform
  console.log(`[MusicFlow Build] ⬇️ Downloading latest official yt-dlp binary for platform: ${process.platform}...`);

  let YTDlpWrap;
  try {
    YTDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
  } catch (e) {}

  if (YTDlpWrap && typeof YTDlpWrap.downloadFromGithub === 'function') {
    try {
      await YTDlpWrap.downloadFromGithub(binaryPath);
      if (!isWin) {
        try { fs.chmodSync(binaryPath, '755'); } catch (e) {}
      }
      console.log(`[MusicFlow Build] ✅ yt-dlp downloaded and marked executable: ${binaryPath}`);
      return;
    } catch (err) {
      console.warn(`[MusicFlow Build] ⚠️ YTDlpWrap download failed, trying direct HTTPS fallback: ${err.message}`);
    }
  }

  // Direct HTTPS GitHub Release download fallback
  let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  if (isWin) downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  else if (isMac) downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';

  await downloadFileWithRedirects(downloadUrl, binaryPath);
  if (!isWin) {
    try { fs.chmodSync(binaryPath, '755'); } catch (e) {}
  }
  console.log(`[MusicFlow Build] ✅ Direct download complete: ${binaryPath}`);
  if (isWin) {
    const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    const launcherCs = path.join(__dirname, 'MusicFlowLauncher.cs');
    const launcherExe = path.join(__dirname, 'MusicFlow.exe');
    if (fs.existsSync(cscPath) && fs.existsSync(launcherCs)) {
      try {
        console.log('[MusicFlow Build] ⚡ Compiling instant launcher MusicFlow.exe...');
        execSync(`"${cscPath}" /target:winexe /optimize+ /out:"${launcherExe}" "${launcherCs}"`, { stdio: 'inherit' });
        console.log('[MusicFlow Build] ✅ MusicFlow.exe compiled successfully!');
      } catch (e) {
        console.warn('[MusicFlow Build] ⚠️ Could not compile C# launcher:', e.message);
      }
    }
  }
}

function downloadFileWithRedirects(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 MusicFlow-Deploy' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFileWithRedirects(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }).on('error', reject);
  });
}

prepareBinaries()
  .then(() => {
    console.log('[MusicFlow Build] 🚀 Binary preparation successfully completed!\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[MusicFlow Build] ⚠️ Warning: Binary preparation encountered note: ${err.message}`);
    // Do not fail build if network is restricted in build phase - server will download at runtime
    process.exit(0);
  });
