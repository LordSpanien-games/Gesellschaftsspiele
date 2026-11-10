#!/usr/bin/env node
/**
 * update.js - Holt vor dem Start die neuesten Dateien vom Repository.
 *
 * Wird von npm automatisch vor "npm start" ausgefuehrt (prestart-Hook).
 *
 * Es werden zwei Installationsarten unterstuetzt:
 *
 * A) git clone (empfohlen)
 *    1. git fetch origin <branch>
 *    2. Arbeitsverzeichnis auf den Remote-Stand setzen:
 *       git reset --hard <remote-sha>  (tracked Dateien)
 *       git clean -fd                 (untracked Dateien, .gitignore bleibt erhalten)
 *
 * B) ZIP-Download von GitHub (kein .git-Ordner)
 *    1. Archiv-URL des Repositorys bestimmen (aus package.json -> repository)
 *    2. pruefen, ob sich das Archiv seit dem letzten Lauf geaendert hat (ETag)
 *    3. Archiv herunterladen, entpacken, Dateien in den Ordner kopieren
 *    4. Dateien, die es im Repository nicht mehr gibt, entfernen
 *
 * In beiden Faellen gilt:
 *   - Wenn package-lock.json sich geaendert hat oder node_modules fehlt:
 *     npm install
 *   - Bei Netzwerkfehlern: Warnung ausgeben und mit der lokalen Version
 *     weiterlaufen
 *   - Lokale Daten (node_modules, playerhistory.json, sessions) bleiben
 *     unangetastet
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SKIP = process.env.SKIP_UPDATE === '1' || process.env.NO_UPDATE === '1';
const STATE_FILE = path.join(ROOT, '.update-state.json');

// Ordner/Dateien, die nie vom Update angefasst werden
const PRESERVE = [
  'node_modules',
  '.git',
  '.update-state.json',
  'games/erzaehl/data/sessions',
  'games/erzaehl/data/playerhistory.json'
];

function log(msg) {
  console.log('[update] ' + msg);
}

function warn(msg) {
  console.warn('[update] WARNUNG: ' + msg);
}

function git(args, timeout = 30000) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout
  });
}

function gitTry(args, timeout = 30000) {
  try {
    return { ok: true, out: git(args, timeout) };
  } catch (err) {
    return { ok: false, out: '', err };
  }
}

function hashFile(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function npmInstall() {
  // Auf Windows muss npm.cmd ueber eine Shell gestartet werden,
  // sonst schlaegt spawnSync mit EINVAL fehl.
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    timeout: 600000
  });
}

// --- gemeinsame Teile ---

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { etag: null, manifest: [] };
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    warn('Statusdatei konnte nicht geschrieben werden: ' + err.message);
  }
}

// Darf diese Datei vom Update ueberschrieben werden?
function isPreserved(relPath) {
  const normalized = relPath.split(path.sep).join('/');
  return PRESERVE.some(p => {
    const pNorm = p.split(path.sep).join('/');
    return normalized === pNorm || normalized.startsWith(pNorm + '/');
  });
}

// Nach dem Update: Abhaengigkeiten pruefen
function ensureDependencies(lockBefore) {
  const lockAfter = hashFile(path.join(ROOT, 'package-lock.json'));
  const nodeModules = fs.existsSync(path.join(ROOT, 'node_modules'));
  const lockChanged = lockBefore && lockAfter && lockBefore !== lockAfter;

  if (!nodeModules || lockChanged) {
    log(!nodeModules ? 'node_modules fehlt - installiere Abhaengigkeiten...'
                     : 'package-lock.json hat sich geaendert - installiere Abhaengigkeiten...');
    try {
      npmInstall();
      log('Abhaengigkeiten installiert.');
    } catch (err) {
      warn('npm install fehlgeschlagen: ' + (err.stderr || err.message).toString().trim());
      warn('Starte trotzdem - vorhandene Abhaengigkeiten werden verwendet.');
    }
  }
}

// --- A) Installation per git clone ---

function updateViaGit() {
  const remote = gitTry(['remote', 'get-url', 'origin']);
  if (!remote.ok) {
    log('Kein "origin"-Remote - Update uebersprungen.');
    return;
  }

  const branchRes = gitTry(['symbolic-ref', '--short', 'HEAD']);
  const branch = branchRes.ok ? branchRes.out.trim() : 'main';

  const lockBefore = hashFile(path.join(ROOT, 'package-lock.json'));

  const fetch = gitTry(['fetch', 'origin', branch, '--quiet'], 45000);
  if (!fetch.ok) {
    warn('Fetch fehlgeschlagen (' + (fetch.err.stderr || fetch.err.message).toString().trim() + ')');
    warn('Starte mit der lokal vorhanden Version.');
    return;
  }

  const headRes = gitTry(['rev-parse', 'HEAD']);
  const remoteRes = gitTry(['rev-parse', 'FETCH_HEAD']);
  if (!headRes.ok || !remoteRes.ok) {
    warn('Konnte HEAD/FETCH_HEAD nicht bestimmen - Update uebersprungen.');
    return;
  }

  const localSha = headRes.out.trim();
  const remoteSha = remoteRes.out.trim();

  const dirty = gitTry(['status', '--porcelain']);
  const dirtyFiles = dirty.ok ? dirty.out.trim() : '';
  const shaChanged = localSha !== remoteSha;

  if (shaChanged) {
    const stat = gitTry(['diff', '--stat', localSha, remoteSha]);
    if (stat.ok && stat.out.trim()) {
      log('Neue Version verfuegbar - geaenderte Dateien:');
      stat.out.trim().split('\n').forEach(line => log('  ' + line.trim()));
    }
    log('Aktualisiere ' + localSha.slice(0, 7) + ' -> ' + remoteSha.slice(0, 7) + '.');
  } else if (dirtyFiles) {
    log('Lokale Aenderungen gefunden, setze Arbeitsverzeichnis auf den Repo-Stand zurueck.');
    dirtyFiles.split('\n').forEach(line => log('  ' + line.trim()));
  } else {
    log('Bereits auf dem neuesten Stand (' + localSha.slice(0, 7) + ').');
  }

  // Lokale Aenderungen werden mit "git stash -u" weggelegt (nicht geloescht).
  if (shaChanged || dirtyFiles) {
    if (dirtyFiles) {
      const stash = gitTry(['stash', 'push', '-u', '-m', 'auto-update backup']);
      if (stash.ok) {
        log('Lokale Aenderungen wurden nach "git stash" ausgelagert (mit "git stash pop" zurueckholbar).');
      } else {
        warn('git stash fehlgeschlagen - lokale Aenderungen bleiben erhalten.');
      }
    }

    const reset = gitTry(['reset', '--hard', remoteSha]);
    if (!reset.ok) {
      warn('git reset fehlgeschlagen - lokalen Stand beibehalten.');
    } else {
      const clean = gitTry(['clean', '-fd']);
      if (clean.ok && clean.out.trim()) {
        clean.out.trim().split('\n').forEach(line => log('  entfernt: ' + line.trim()));
      }
      log('Arbeitsverzeichnis entspricht jetzt dem Repository-Stand.');
    }
  }

  ensureDependencies(lockBefore);
}

// --- B) Installation per ZIP (kein .git) ---

// Repository-URL aus package.json lesen
function readRepoUrl() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const repo = pkg.repository;
    let url = typeof repo === 'string' ? repo : (repo && repo.url);
    if (!url) return null;
    url = url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
    return url;
  } catch {
    return null;
  }
}

// HTTPS-Request mit Redirect-Follow (max. 5)
function request(url, method = 'GET', redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, timeout: 60000 }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('zu viele Redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, method, redirects + 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + status + ' bei ' + url));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks),
        headers: res.headers
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zeitüberschreitung bei ' + url)); });
    req.end();
  });
}

// ZIP entpacken. Reihenfolge:
//   1. tar.exe aus dem Windows-System (bsdtar - kann ZIPs entpacken)
//   2. unzip (falls im PATH vorhanden)
//   3. PowerShell Expand-Archive als letzte Option
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  const runTool = (cmd, args) => {
    try {
      execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
      return true;
    } catch {
      return false;
    }
  };

  // 1. Windows-System-tar (bsdtar) - unterstuetzt ZIP-Archive.
  //    Wichtig: "/usr/bin/unzip" ist ein MSYS-Pfad und von Node aus
  //    nicht aufrufbar, daher hier bewusst nur echte Windows-Pfade.
  const winTar = 'C:/Windows/System32/tar.exe';
  if (process.platform === 'win32' && fs.existsSync(winTar)) {
    if (runTool(winTar, ['-xf', zipPath, '-C', destDir])) return;
  }

  // 2. unzip aus dem PATH
  if (runTool('unzip', ['-q', '-o', zipPath, '-d', destDir])) return;

  // 3. tar aus dem PATH
  if (runTool('tar', ['-xf', zipPath, '-C', destDir])) return;

  // 4. PowerShell
  if (process.platform === 'win32') {
    // Forward-Slashes verwenden: Backslashes sind in PowerShell-Strings
    // je nach Kontext Escape-Zeichen.
    const psPath = p => p.split(path.sep).join('/').replace(/'/g, "''");
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Expand-Archive -LiteralPath '" + psPath(zipPath) +
      "' -DestinationPath '" + psPath(destDir) + "' -Force"
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    return;
  }

  throw new Error('kein Entpackwerkzeug verfuegbar');
}

// Ordnerinhalt rekursiv kopieren, Liste der kopierten Dateien sammeln
function copyTree(srcDir, destDir, relBase, collected) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase ? path.join(relBase, entry.name) : entry.name;
    if (isPreserved(rel)) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(src, dest, rel, collected);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      collected.push(rel.split(path.sep).join('/'));
    }
  }
}

// Alle Dateien im lokalen Ordner sammeln (ohne die zu erhaltenden Bereiche)
function collectLocalFiles(dir, relBase, collected) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    const rel = relBase ? path.join(relBase, entry.name) : entry.name;
    if (isPreserved(rel)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectLocalFiles(abs, rel, collected);
    } else {
      collected.push(rel.split(path.sep).join('/'));
    }
  }
  return collected;
}

// Die Dateiliste des letzten Laufs als "bekannte Repository-Dateien"
function collectedFromManifest(state) {
  return state.manifest || [];
}

// Entfernt lokale Dateien, die nicht zum Repository gehoeren.
function removeStaleFiles(repoFiles, etag) {
  const localFiles = collectLocalFiles(ROOT, '', []);
  const known = new Set(repoFiles);
  let removed = 0;
  for (const rel of localFiles) {
    if (known.has(rel)) continue;
    if (isPreserved(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs);
        removed++;
      } catch (err) {
        warn('Konnte ' + rel + ' nicht entfernen: ' + err.message);
      }
    }
  }
  if (removed > 0) log(removed + ' veraltete Datei(en) entfernt.');
  return removed;
}

async function updateViaArchive() {
  const repoUrl = readRepoUrl();
  if (!repoUrl) {
    log('Kein Git-Repository und keine Repository-URL in package.json gefunden - Update uebersprungen.');
    log('Tipp: Mit "git clone" statt ZIP-Installation laeuft das automatische Update auch ohne diesen Hinweis.');
    return;
  }

  const branch = process.env.GS_BRANCH || 'main';
  const archiveUrl = repoUrl + '/archive/refs/heads/' + branch + '.zip';

  const lockBefore = hashFile(path.join(ROOT, 'package-lock.json'));
  const state = readState();

  // 1. Pruefen, ob sich das Archiv seit dem letzten Lauf geaendert hat
  let etag = null;
  try {
    const head = await request(archiveUrl, 'HEAD');
    etag = head.headers.etag || null;
  } catch (err) {
    warn('Repository nicht erreichbar (' + err.message + ')');
    warn('Starte mit der lokal vorhanden Version.');
    return;
  }

  if (etag && state.etag && state.etag === etag) {
    log('Bereits auf dem neuesten Stand (ZIP-Installation).');
    // Trotzdem aufraeumen: es koennen Dateien liegen, die es im
    // Repository nicht mehr gibt (z.B. aus einer aelteren Installation).
    removeStaleFiles(collectedFromManifest(state), etag);
    ensureDependencies(lockBefore);
    return;
  }

  // 2. Archiv herunterladen und entpacken
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-update-'));
  try {
    log('Lade neue Version von ' + archiveUrl + ' ...');
    const res = await request(archiveUrl, 'GET');
    const zipPath = path.join(tmpDir, 'repo.zip');
    fs.writeFileSync(zipPath, res.body);

    const extractDir = path.join(tmpDir, 'extract');
    extractZip(zipPath, extractDir);

    // GitHub legt alles in einen Ordner "Repo-Branch" ab
    const topEntries = fs.readdirSync(extractDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
    if (topEntries.length !== 1) {
      warn('Archiv hat ein unerwartetes Layout - Update uebersprungen.');
      return;
    }
    const sourceDir = path.join(extractDir, topEntries[0].name);

    // 3. Dateien kopieren
    const collected = [];
    copyTree(sourceDir, ROOT, '', collected);
    log(collected.length + ' Dateien aktualisiert.');

    // 4. Dateien entfernen, die es im Repository nicht mehr gibt.
    //    Gescannt wird der lokale Ordner (nicht nur das Manifest), damit
    //    auch veraltete Dateien aus frueheren Installationen verschwinden.
    removeStaleFiles(collected, etag);

    // 5. Status speichern und Abhaengigkeiten pruefen
    writeState({ etag: etag, manifest: collected });
    ensureDependencies(lockBefore);
  } catch (err) {
    warn('Update fehlgeschlagen: ' + err.message);
    warn('Starte mit der lokal vorhanden Version.');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignorieren */ }
  }
}

async function main() {
  if (SKIP) {
    log('SKIP_UPDATE gesetzt - Update uebersprungen.');
    return;
  }

  if (fs.existsSync(path.join(ROOT, '.git'))) {
    updateViaGit();
  } else {
    await updateViaArchive();
  }
}

main().catch((err) => {
  warn('Update fehlgeschlagen: ' + err.message);
  warn('Starte mit der lokal vorhanden Version.');
});
