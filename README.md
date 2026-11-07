# Gesellschaftsspiele

Ein Launcher für vier Partyspiele, die alle im selben Raum auf Handys oder
Laptops gespielt werden. Jedes Spiel läuft in einem eigenen Socket.IO-Namespace
und hat eine eigene Lobby, Regeln-Seite und Punktelogik.

## Die Spiele

| Spiel | Pfad | Kurzbeschreibung |
|---|---|---|
| 🎲 **Erzähl keinen Scheiß** | `/erzaehl` | Baue geheime Sätze oder Wörter unauffällig in echte Gespräche ein. Punkte über Bestätigung oder Aufdecken. |
| 🎭 **Cyrano** | `/cyrano` | Schreibe zu einem Begriff eine Strophe, stimme über die besten ab und steige den Turm hoch. |
| 🔄 **So aber anders** | `/so-aber-anders` | Erkläre einen Begriff nur durch Umschreibungen. Tabuwörter und ein Kontrolleur machen es tricky. |
| 💬 **Das eine Wort** | `/das-eine-wort` | Ein Spieler rät, alle anderen geben je einen Hinweis. Duplikate werden gemeinsam markiert. |

## Installation

```bash
git clone <repository-url>
cd gesellschaftsspiele
npm install
npm start
```

Der Launcher läuft danach auf http://localhost:3000

### Automatisches Update

`npm start` holt **vor** dem eigentlichen Start immer die neuesten Dateien vom
Repository:

1. `git fetch origin <branch>`
2. Falls der Remote-Stand neuer ist: lokale Versionen verwerfen und auf den
   Remote-Stand setzen (`git reset --hard`)
3. Falls sich `package-lock.json` geändert hat oder `node_modules` fehlt:
   `npm install`
4. Danach startet der Server

Das Update läuft über `scripts/update.js`, das per npm-`prestart`-Hook vor
`server.js` ausgeführt wird.

Offline-Verhalten: Schlägt der Fetch fehl (kein Netz), gibt es eine Warnung und
der Server startet mit der lokal vorhanden Version.

Update überspringen:

```bash
SKIP_UPDATE=1 npm start
```

## Projektstruktur

```
server.js                  Express + Socket.IO, registriert die 4 Namespaces
scripts/update.js          Auto-Update beim Start
public/                    Launcher-Startseite
games/
  erzaehl/                 router.js, socket.js, sentences.js, public/, data/
  cyrano/                  router.js, socket.js, public/
  so-aber-anders/          router.js, socket.js, public/, data/wordlists/
  das-eine-wort/           router.js, socket.js, public/, data/
```

## Technik

- Node.js (ab 18)
- Express 4 für die statischen Seiten und Routen
- Socket.IO 4 für die Echtzeit-Kommunikation
- Reines Vanilla-JS im Frontend, kein Build-Schritt

## Bekannte Fehler

Keine bekannten Abstürze. Folgendes ist bereits behoben:

- **Server-Crash in „So aber anders"** (behoben): Disconnectet der letzte Spieler
  einer Session, während ein `setTimeout` für den nächsten Begriff läuft, griff
  der Timeout auf eine gelöschte Session zu und der Node-Prozess stürzte ab
  (`games/so-aber-anders/socket.js`). Alle Zugriffe prüfen jetzt, ob die Session
  noch existiert.

## Nicht ausgewertete Einstellungen

Diese Optionen werden vom Frontend angeboten, aber vom Server noch nicht
ausgewertet:

- **Das eine Wort**: `mode` (klassisch / Emote-Edition / Redewendungen)
- **So aber anders**: `mode` (Einzelspieler / Teams) und `rotation`
  (Reihum / Team-Rotation / Host wählt)

## Lizenz

Privat / frei verwendbar.
