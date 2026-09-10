import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  CLOUDFLARED_VERSION,
  cloudflaredReleaseAsset,
  cloudflaredReleaseUrl,
  readCloudflaredAssetResponse,
  verifyCloudflaredAsset
} from './cloudflared-release.mjs';
import {
  commandAvailable,
  commandExists,
  executableFileExists,
  isPathLike,
  resolveExecutablePath
} from './cli-executables.mjs';
import { codexProHome } from './workspace-profile-store.mjs';

export function createCliTunnelExecutables({ spawnSyncPortable, executableHelpers = {} } = {}) {
  if (typeof spawnSyncPortable !== 'function') {
    throw new Error('createCliTunnelExecutables requires spawnSyncPortable.');
  }

  const commandAvailableFn = executableHelpers.commandAvailable ?? commandAvailable;
  const commandExistsFn = executableHelpers.commandExists ?? commandExists;
  const executableFileExistsFn = executableHelpers.executableFileExists ?? executableFileExists;
  const isPathLikeFn = executableHelpers.isPathLike ?? isPathLike;
  const resolveExecutablePathFn = executableHelpers.resolveExecutablePath ?? resolveExecutablePath;

  function cloudflaredBinName() {
    return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  }

  function localCloudflaredPath() {
    return path.join(codexProHome(), 'bin', cloudflaredBinName());
  }

  function findFileByName(root, fileName) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isFile() && entry.name === fileName) return fullPath;
      if (entry.isDirectory()) {
        const found = findFileByName(fullPath, fileName);
        if (found) return found;
      }
    }
    return '';
  }

  async function downloadFile(url, destination, asset) {
    const response = await fetch(url, {
      headers: { 'user-agent': 'codexpro-launcher' }
    });
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    const buffer = await readCloudflaredAssetResponse(response, asset);
    verifyCloudflaredAsset(asset, buffer);
    fs.writeFileSync(destination, buffer, { mode: 0o755 });
  }

  function verifyCloudflared(binaryPath) {
    const result = spawnSyncPortable(binaryPath, ['--version'], {
      stdio: 'ignore',
      timeout: 15000
    });
    if (result.status !== 0) {
      throw new Error(`Downloaded cloudflared, but ${binaryPath} --version failed.`);
    }
  }

  async function installCloudflaredLocal() {
    const asset = cloudflaredReleaseAsset();
    const installPath = localCloudflaredPath();
    const binDir = path.dirname(installPath);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-cloudflared-'));
    const url = cloudflaredReleaseUrl(asset);

    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    console.error(`[codexpro] Installing cloudflared locally: ${installPath}`);
    console.error(`[codexpro] Downloading verified Cloudflare release ${CLOUDFLARED_VERSION}: ${asset.file}`);

    try {
      if (asset.archive) {
        const archivePath = path.join(tmpRoot, asset.file);
        const extractDir = path.join(tmpRoot, 'extract');
        fs.mkdirSync(extractDir, { recursive: true });
        await downloadFile(url, archivePath, asset);
        const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false
        });
        if (tar.status !== 0) {
          throw new Error(`Failed to extract ${asset.file}: ${tar.stderr || tar.stdout || `exit ${tar.status}`}`);
        }
        const extracted = findFileByName(extractDir, 'cloudflared');
        if (!extracted) throw new Error(`Could not find cloudflared inside ${asset.file}`);
        fs.copyFileSync(extracted, installPath);
      } else {
        const tmpBinary = path.join(tmpRoot, cloudflaredBinName());
        await downloadFile(url, tmpBinary, asset);
        fs.copyFileSync(tmpBinary, installPath);
      }

      if (process.platform !== 'win32') fs.chmodSync(installPath, 0o755);
      verifyCloudflared(installPath);
      console.error('[codexpro] cloudflared installed successfully.');
      return installPath;
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  async function resolveCloudflared(args) {
    const explicit = args.cloudflared ?? process.env.CLOUDFLARED_BIN ?? '';
    if (explicit) {
      const resolved = isPathLikeFn(explicit) ? resolveExecutablePathFn(explicit) : explicit;
      if (commandAvailableFn(resolved)) {
        verifyCloudflared(resolved);
        return resolved;
      }
      throw new Error(`cloudflared was not found at ${explicit}. Remove --cloudflared, install it, or pass a valid path.`);
    }

    if (!args.installCloudflared && commandExistsFn('cloudflared')) {
      try {
        verifyCloudflared('cloudflared');
        return 'cloudflared';
      } catch (error) {
        console.error(`[codexpro] cloudflared in PATH failed --version; trying local install. ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const localPath = localCloudflaredPath();
    if (!args.installCloudflared && executableFileExistsFn(localPath)) {
      try {
        verifyCloudflared(localPath);
        return localPath;
      } catch (error) {
        if (args.noInstallCloudflared) return localPath;
        console.error(`[codexpro] Existing ${localPath} failed --version; reinstalling. ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (args.noInstallCloudflared) return '';
    return installCloudflaredLocal();
  }

  function verifyNgrok(binaryPath) {
    const result = spawnSyncPortable(binaryPath, ['version'], {
      stdio: 'ignore',
      timeout: 15000
    });
    if (result.status !== 0) {
      throw new Error(`ngrok was found, but ${binaryPath} version failed. Run ngrok version to inspect it.`);
    }
  }

  function resolveNgrok(args) {
    const explicit = args.ngrok ?? process.env.NGROK_BIN ?? '';
    if (explicit) {
      const resolved = isPathLikeFn(explicit) ? resolveExecutablePathFn(explicit) : explicit;
      if (commandAvailableFn(resolved)) {
        verifyNgrok(resolved);
        return resolved;
      }
      throw new Error(`ngrok was not found at ${explicit}. Install ngrok, add it to PATH, or pass --ngrok <path>.`);
    }

    if (commandExistsFn('ngrok')) {
      verifyNgrok('ngrok');
      return 'ngrok';
    }

    throw new Error('ngrok was not found on PATH. Install it with Homebrew, winget, apt, or from https://ngrok.com/download, then run ngrok config add-authtoken <token>.');
  }

  function verifyTailscale(binaryPath) {
    const result = spawnSyncPortable(binaryPath, ['version'], {
      stdio: 'ignore',
      timeout: 15000
    });
    if (result.status !== 0) {
      throw new Error(`tailscale was found, but ${binaryPath} version failed. Run tailscale version to inspect it.`);
    }
  }

  function resolveTailscale(args) {
    const explicit = args.tailscale ?? process.env.TAILSCALE_BIN ?? '';
    if (explicit) {
      const resolved = isPathLikeFn(explicit) ? resolveExecutablePathFn(explicit) : explicit;
      if (commandAvailableFn(resolved)) {
        verifyTailscale(resolved);
        return resolved;
      }
      throw new Error(`tailscale was not found at ${explicit}. Install Tailscale, add it to PATH, or pass --tailscale <path>.`);
    }

    if (commandExistsFn('tailscale')) {
      verifyTailscale('tailscale');
      return 'tailscale';
    }

    throw new Error('tailscale was not found on PATH. Install Tailscale and enable Funnel, then run codexpro tailscale --hostname your-device.your-tailnet.ts.net.');
  }

  return {
    cloudflaredBinName,
    localCloudflaredPath,
    findFileByName,
    downloadFile,
    verifyCloudflared,
    installCloudflaredLocal,
    resolveCloudflared,
    verifyNgrok,
    resolveNgrok,
    verifyTailscale,
    resolveTailscale
  };
}
