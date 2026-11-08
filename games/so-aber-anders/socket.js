const fs = require("fs");
const path = require("path");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function loadWordlists() {
  const dir = path.join(__dirname, "data", "wordlists");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const lists = {};
  files.forEach(file => {
    const name = file.replace(".json", "");
    const raw = fs.readFileSync(path.join(dir, file), "utf8")
      .replace(/^\uFEFF/, "");
    lists[name] = JSON.parse(raw);
  });
  return lists;
}

const wordlists = loadWordlists();
const sessions = {};
// Timeout-Handles des Timers. Sie stehen bewusst getrennt von den
// Session-Objekten: diese werden an Clients serialisiert, und ein
// Node-Timeout enthaelt zyklische Referenzen -> Serialisierungs-Crash.
const timerHandles = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function randomLetter() {
  return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}

// Ist die Socket-ID der aktuell aktive Erklärer?
function isExplainer(session, socketId) {
  const explainer = session.players[session.currentPlayerIndex];
  return !!explainer && explainer.id === socketId;
}

// Ist die Socket-ID der aktuell aktive Kontrolleur?
function isController(session, socketId) {
  return !!session.controllerId && session.controllerId === socketId;
}

// --- Timer ---
// Der Server ist die einzige Zeitquelle: alle Spieler sehen dadurch
// denselben Countdown. Der Client zeigt nur noch an, was der Server schickt.

// Startet den Timer neu. Bei timerScope "turn" wird er nur einmal pro Zug
// gestartet (und laeuft ueber alle Woerter weiter), bei "word" pro Begriff.
function startTurnTimer(code, io, session) {
  clearTurnTimer(code, io, session);
  if (!session.settings.timer) return;

  const seconds = session.settings.timerDuration || 60;
  const endsAt = Date.now() + seconds * 1000;
  session.timerEndsAt = endsAt;

  io.to(code).emit("timerState", {
    active: true,
    endsAt: endsAt,
    duration: seconds,
    scope: session.settings.timerScope || "turn"
  });

  timerHandles[code] = setTimeout(() => {
    // Zustand kann sich inzwischen geaendert haben -> immer neu pruefen
    const current = sessions[code];
    if (!current) return;
    if (current.timerEndsAt !== endsAt) return; // Timer wurde ersetzt
    delete timerHandles[code];
    current.timerEndsAt = null;
    io.to(code).emit("timerState", { active: false });
    io.to(code).emit("timerExpired");
    advanceToNextPlayer(code, io);
  }, seconds * 1000);
}

// Stoppt den Timer und informiert die Clients.
function clearTurnTimer(code, io, session) {
  if (timerHandles[code]) {
    clearTimeout(timerHandles[code]);
    delete timerHandles[code];
  }
  const had = session.timerEndsAt !== null;
  session.timerEndsAt = null;
  if (had && io) {
    io.to(code).emit("timerState", { active: false });
  }
}

module.exports = function(io) {

  io.on("connection", (socket) => {

    socket.on("createSession", ({ name, settings }) => {
      const code = generateCode();
      sessions[code] = {
        code,
        host: socket.id,
        players: [{ id: socket.id, name, score: 0 }],
        settings,
        usedWords: [],
        state: "lobby",   // lobby | running
        phase: "playing", // playing | letter
        currentPlayerIndex: 0,
        currentRound: 1,
        wordsThisTurn: 0,
        controller: null,
        controllerId: null,
        // Moeser Mamster
        currentLetter: null,
        letterSubmissions: {},
        // Aktueller Begriff inkl. Tabuwörtern (nur an die Rollen verteilt)
        currentTerm: null,
        currentForbidden: [],
        // Timer-Endzeitpunkt (serverautoritativ, wird serialisiert)
        timerEndsAt: null
      };
      socket.join(code);
      socket.emit("sessionCreated", { code });
      io.to(code).emit("updateLobby", sessions[code]);
    });

    socket.on("joinSession", ({ code, name }) => {
      const session = sessions[code];
      if (!session || session.state === "running") {
        socket.emit("error", "Session nicht gefunden oder laeuft bereits");
        return;
      }
      session.players.push({ id: socket.id, name, score: 0 });
      socket.join(code);
      io.to(code).emit("updateLobby", session);
    });

    socket.on("startGame", ({ code }) => {
      const session = sessions[code];
      if (!session || session.host !== socket.id) return;
      resetSession(session);
      session.state = "running";
      session.phase = "playing";
      io.to(code).emit("gameStarted", session);
      setTimeout(() => startTurn(code, io), 500);
    });

    socket.on("restartGame", ({ code }) => {
      const session = sessions[code];
      if (!session || session.host !== socket.id) return;
      // Zurueck in Lobby – neue Spieler koennen beitreten
      session.state = "lobby";
      session.phase = "playing";
      session.players.forEach(p => p.score = 0);
      resetSession(session);
      io.to(code).emit("backToLobby", session);
    });

    socket.on("wordCorrect", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
      // Nur der Erklärer darf das Ergebnis melden
      if (!isExplainer(session, socket.id)) return;
      const player = session.players[session.currentPlayerIndex];
      if (!player) return;
      player.score += 1;
      session.wordsThisTurn += 1;
      io.to(code).emit("scoreUpdate", session.players);
      checkTurnEnd(code, io);
    });

    socket.on("wordSkip", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
      if (!isExplainer(session, socket.id)) return;
      // Passen muss in der Lobby erlaubt sein - auch serverseitig geprueft,
      // damit ein manipulierter Client es nicht umgehen kann.
      if (!session.settings.skipAllowed) return;
      const player = session.players[session.currentPlayerIndex];
      if (!player) return;
      if (session.settings.minusOnSkip) {
        player.score -= 1;
      }
      session.wordsThisTurn += 1;
      io.to(code).emit("scoreUpdate", session.players);
      io.to(code).emit("wordSkipped", {
        skippedBy: player.name,
        penalty: session.settings.minusOnSkip ? -1 : 0
      });
      checkTurnEnd(code, io);
    });

    socket.on("violation", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
      // Nur der Kontrolleur darf einen Regelverstoß melden
      if (!isController(session, socket.id)) return;
      const player = session.players[session.currentPlayerIndex];
      if (!player) return;
      if (session.settings.minusOnViolation) {
        player.score -= 1;
      }
      session.wordsThisTurn += 1;
      io.to(code).emit("scoreUpdate", session.players);
      checkTurnEnd(code, io);
    });

    socket.on("timerEnd", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
      // Der Server steuert den Timer selbst. Diese Meldung kommt nur von
      // aelteren Clients und wird ignoriert.
    });

    // --- Moeser Mamster: Buchstabe vorschlagen (Gruppe bestimmt mit) ---
    socket.on("submitLetter", ({ code, letter }) => {
      const session = sessions[code];
      if (!session || session.phase !== "letter") return;
      const normalized = String(letter || "").trim().toUpperCase();
      if (!/^[A-Z]$/.test(normalized)) return;
      if (session.letterSubmissions[socket.id]) return;
      session.letterSubmissions[socket.id] = normalized;

      const total = session.players.length;
      const submitted = Object.keys(session.letterSubmissions).length;
      io.to(code).emit("letterProgress", { submitted, total });

      if (submitted === total) resolveLetter(code, io);
    });

    socket.on("rejoinSession", ({ code, name }) => {
      const session = sessions[code];
      if (!session) {
        socket.emit("error", "Session nicht gefunden");
        return;
      }
      const player = session.players.find(p => p.name === name);
      if (player) {
        const wasController = player.id === session.controllerId;
        player.id = socket.id;
        // Socket-ID hat sich geaendert: Kontrolleur-ID nachziehen
        if (wasController) session.controllerId = socket.id;
        socket.join(code);
        if (session.state === "lobby") {
          io.to(code).emit("updateLobby", session);
        } else {
          socket.emit("newTurn", {
            explainer: session.players[session.currentPlayerIndex] ? session.players[session.currentPlayerIndex].name : null,
            controller: session.controller || null,
            letter: session.currentLetter,
            players: session.players,
            settings: session.settings,
            round: session.currentRound
          });
          if (session.phase === "letter") {
            socket.emit("letterPhase", {
              submitted: Object.keys(session.letterSubmissions).length,
              total: session.players.length
            });
          }
          // Begriff an die passenden Rollen nachschieben
          sendWordToRoles(code, io, session);
          // Laufenden Timer an den Wiederverbindenden melden
          if (session.timerEndsAt) {
            socket.emit("timerState", {
              active: true,
              endsAt: session.timerEndsAt,
              duration: session.settings.timerDuration || 60,
              scope: session.settings.timerScope || "turn"
            });
          }
        }
      }
    });

    socket.on("disconnect", () => {
      for (const code in sessions) {
        const session = sessions[code];
        session.players = session.players.filter(p => p.id !== socket.id);
        delete session.letterSubmissions[socket.id];

        if (session.players.length === 0) {
          // Timer laeuft nicht mehr weiter, wenn niemand mehr da ist
          if (timerHandles[code]) {
            clearTimeout(timerHandles[code]);
            delete timerHandles[code];
          }
          session.timerEndsAt = null;
          delete sessions[code];
          continue;
        }

        // Index auf einen gueltigen Spieler zuruecksetzen
        if (session.currentPlayerIndex >= session.players.length) {
          session.currentPlayerIndex = 0;
        }

        // Buchstabenphase: letzte Einreichung nach Disconnect aufloesen
        if (session.phase === "letter" &&
            Object.keys(session.letterSubmissions).length >= session.players.length) {
          resolveLetter(code, io);
          continue;
        }

        io.to(code).emit("updateLobby", session);
      }
    });
  });
};

function resetSession(session) {
  session.usedWords = [];
  session.currentPlayerIndex = 0;
  session.currentRound = 1;
  session.wordsThisTurn = 0;
  session.controller = null;
  session.currentLetter = null;
  session.letterSubmissions = {};
  session.currentTerm = null;
  session.currentForbidden = [];
  session.timerEndsAt = null;
  if (timerHandles[session.code]) {
    clearTimeout(timerHandles[session.code]);
    delete timerHandles[session.code];
  }
  session.players.forEach(p => p.score = 0);
}

// Startet den Zug. Im Moeser-Mamster-Modus wird zuerst der Buchstabe
// festgelegt: per Zufall oder durch Vorschlaege der Gruppe.
function startTurn(code, io) {
  const session = sessions[code];
  if (!session) return;
  session.wordsThisTurn = 0;
  const explainerIndex = session.currentPlayerIndex;
  const controllerIndex = (explainerIndex + 1) % session.players.length;
  session.controller = session.players[controllerIndex].name;
  session.controllerId = session.players[controllerIndex].id;

  if (session.settings.moeserMamster) {
    if (session.settings.letterMode === "group") {
      session.phase = "letter";
      session.letterSubmissions = {};
      io.to(code).emit("letterPhase", { submitted: 0, total: session.players.length });
      return;
    }
    session.currentLetter = randomLetter();
    io.to(code).emit("letterChosen", { letter: session.currentLetter });
  }

  beginTurn(code, io);
}

// Turn wird angekuendigt und der Begriff verteilt.
function beginTurn(code, io) {
  const session = sessions[code];
  if (!session) return;
  session.phase = "playing";
  const explainerIndex = session.currentPlayerIndex;
  io.to(code).emit("newTurn", {
    explainer: session.players[explainerIndex] ? session.players[explainerIndex].name : null,
    controller: session.controller,
    letter: session.currentLetter,
    players: session.players,
    settings: session.settings,
    round: session.currentRound
  });
  // Bei timerScope "turn" startet die Uhr hier einmal fuer den ganzen Zug
  // und laeuft ueber alle Woerter weiter.
  if ((session.settings.timerScope || "turn") === "turn") {
    startTurnTimer(code, io, session);
  }
  setTimeout(() => sendNextWord(code, io), 300);
}

// Aus den Vorschlaegen der Gruppe wird einer per Zufall gewaehlt.
function resolveLetter(code, io) {
  const session = sessions[code];
  if (!session) return;
  const letters = Object.values(session.letterSubmissions);
  if (letters.length === 0) {
    session.currentLetter = randomLetter();
  } else {
    session.currentLetter = letters[Math.floor(Math.random() * letters.length)];
  }
  session.letterSubmissions = {};
  session.phase = "playing";
  io.to(code).emit("letterChosen", { letter: session.currentLetter });
  beginTurn(code, io);
}

// Der Begriff geht nur an den Erklaerer, die Tabuwörter an Erklaerer und
// Kontrolleur. So sieht niemand sonst den Begriff.
function sendWordToRoles(code, io, session) {
  if (!session.currentTerm) return;
  const explainer = session.players[session.currentPlayerIndex];
  const controller = session.players.find(p => p.id === session.controllerId);
  const forbidden = session.currentForbidden || [];

  if (explainer) {
    io.to(explainer.id).emit("newWord", {
      term: session.currentTerm,
      forbidden,
      letter: session.currentLetter
    });
  }
  if (controller) {
    io.to(controller.id).emit("forbiddenWords", { forbidden });
  }
}

function sendNextWord(code, io) {
  const session = sessions[code];
  if (!session) return;
  const listName = session.settings.wordlist || "standard";
  const list = (wordlists[listName] || wordlists.standard).words.filter(
    w => !session.usedWords.includes(w.term)
  );
  if (list.length === 0) {
    io.to(code).emit("gameOver", session.players);
    return;
  }
  const word = list[Math.floor(Math.random() * list.length)];
  session.usedWords.push(word.term);
  const tabooCount = session.settings.tabooCount || 3;
  const forbidden = word.forbidden
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, tabooCount);

  session.currentTerm = word.term;
  session.currentForbidden = forbidden;
  sendWordToRoles(code, io, session);

  // Bei timerScope "word" startet die Uhr fuer jedes Wort neu.
  // Bei "turn" laeuft die Uhr weiter und wird hier nicht angefasst.
  if ((session.settings.timerScope || "turn") === "word") {
    startTurnTimer(code, io, session);
  }
}

function checkTurnEnd(code, io) {
  const session = sessions[code];
  if (!session) return;
  if (session.settings.timer) {
    sendNextWord(code, io);
    return;
  }
  if (session.wordsThisTurn >= session.settings.wordsPerRound) {
    advanceToNextPlayer(code, io);
  } else {
    sendNextWord(code, io);
  }
}

function advanceToNextPlayer(code, io) {
  const session = sessions[code];
  if (!session) return;
  // Timer des bisherigen Zugs beenden, bevor der naechste startet
  clearTurnTimer(code, io, session);
  const nextIndex = session.currentPlayerIndex + 1;

  if (nextIndex < session.players.length) {
    session.currentPlayerIndex = nextIndex;
    startTurn(code, io);
    return;
  }

  // Alle Spieler dran gewesen - Spielende pruefen
  if (checkGameEnd(session)) {
    io.to(code).emit("gameOver", session.players);
    return;
  }

  // Neue Runde
  const finishedRound = session.currentRound;
  session.currentRound += 1;
  session.currentPlayerIndex = 0;
  io.to(code).emit("roundEnd", {
    round: finishedRound,
    players: session.players
  });
  setTimeout(() => startTurn(code, io), 3000);
}

function checkGameEnd(session) {
  const s = session.settings;
  if (s.endMode === "rounds") {
    return session.currentRound >= s.rounds;
  }
  if (s.endMode === "points") {
    return session.players.some(p => p.score >= s.targetScore);
  }
  if (s.endMode === "both") {
    return session.currentRound >= s.rounds ||
           session.players.some(p => p.score >= s.targetScore);
  }
  return false;
}
