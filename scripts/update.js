#!/usr/bin/env node
/**
 * update.js - Holt vor dem Start die neuesten Dateien vom Repository.
 *
 * Wird von npm automatisch vor "npm start" ausgefuehrt (prestart-Hook).
 *
 * Der lokale Ordner wird als Spiegel des Repository behandelt:
 *   1. Ohne Git-Repo, ohne "origin"-Remote oder mit SKIP_UPDATE=1 -> ueberspringen
 *   2. git fetch origin <branch>
 *   3. Arbeitsverzeichnis auf den Remote-Stand setzen:
 *      git reset --hard <remote-sha>  (tracked Dateien)
 *      git clean -fd                 (untracked Dateien, .gitignore bleibt erhalten)
 *   4. Wenn package-lock.json sich geaendert hat oder node_modules fehlt: npm install
 *   5. Bei Netzwerkfehlern: Warnung ausgeben und mit der lokalen Version weiterlaufen
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SKIP = process.env.SKIP_UPDATE === '1' || process.env.NO_UPDATE === '1';

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

function main() {
  if (SKIP) {
    log('SKIP_UPDATE gesetzt - Update uebersprungen.');
    return;
  }

  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    log('Kein Git-Repository gefunden - Update uebersprungen.');
    return;
  }

  const remote = gitTry(['remote', 'get-url', 'origin']);
  if (!remote.ok) {
    log('Kein "origin"-Remote - Update uebersprungen.');
    return;
  }

  const branchRes = gitTry(['symbolic-ref', '--short', 'HEAD']);
  const branch = branchRes.ok ? branchRes.out.trim() : 'main';

  const lockBefore = hashFile(path.join(ROOT, 'package-lock.json'));

  // 1. Remote-Stand holen
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

  // 2. Was unterscheidet sich?
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

  // 3. Arbeitsverzeichnis auf den Repo-Stand setzen. Das passiert auch dann,
  //    wenn der SHA gleich ist, aber lokal etwas geaendert wurde - so entspricht
  //    der Ordner garantiert dem Repository.
  //
  //    Lokale Aenderungen werden vorher mit "git stash -u" weggelegt (nicht
  //    geloescht) - sie lassen sich mit "git stash pop" zurueckholen.
  //    Ignorierte Dateien (node_modules, playerhistory.json, sessions) bleiben
  //    unangetastet.
  if (shaChanged || dirtyFiles) {
    if (dirtyFiles) {
      const stash = gitTry(['stash', 'push', '-u', '-m', 'auto-update backup']);
      if (stash.ok) {
        log('Lokale Aenderungen wurden nach "git stash" ausgelagert (mit "git stash pop" zurueckholbar).');
      } else {
        warn('git stash fehlgeschlagen - lokale Aenderungen bleiben erhalten, setze nur den Repo-Stand durch.');
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

  // 4. Abhaengigkeiten pruefen
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

try {
  main();
} catch (err) {
  warn('Update fehlgeschlagen: ' + err.message);
  warn('Starte mit der lokal vorhanden Version.');
}
