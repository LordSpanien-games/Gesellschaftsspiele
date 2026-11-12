const fs = require("fs");
const path = require("path");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const sharedPath = path.join(__dirname, "..", "shared", "data", "wordlist.json");
const shared = JSON.parse(fs.readFileSync(sharedPath, "utf8"));
const allSharedWords = shared.words;

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
      // Einzelspieler-Modus entfernt: nur noch Teams. Debug-Modus erlaubt Einzelspieler-Test.
      settings.mode = "team";
      sessions[code] = {
        code,
        host: socket.id,
        players: [{ id: socket.id, name, score: 0, teamId: "team-1" }],
        teams: {
          "team-1": { name: "Team A", members: ["team-1-host-marker"] }
        },
        settings,
        usedWords: [],
        state: "lobby",
        phase: "playing",
        currentPlayerIndex: 0,
        currentRound: 1,
        wordsThisTurn: 0,
        controller: null,
        controllerId: null,
        confirmedControllerId: null, // Wer sich als Kontrolleur fuer den aktuellen Zug bestaetigt hat
        // Moeser Mamster
        currentLetter: null,
        letterSubmissions: {},
        // Aktueller Begriff inkl. Tabuwörtern
        currentTerm: null,
        currentForbidden: [],
        // Timer-Endzeitpunkt
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
      // Spieler kommt erst ohne Team - er waehlt selbst in der Lobby
      session.players.push({ id: socket.id, name, score: 0, teamId: null });
      socket.join(code);
      io.to(code).emit("updateLobby", session);
    });

    // Spieler waehlt ein Team oder erstellt ein neues
    socket.on("selectTeam", ({ code, teamId, teamName }) => {
      const session = sessions[code];
      if (!session) return;
      const player = session.players.find(p => p.id === socket.id);
      if (!player) return;

      // Aus altem Team entfernen
      if (player.teamId && session.teams[player.teamId]) {
        const oldTeam = session.teams[player.teamId];
        oldTeam.members = oldTeam.members.filter(m => m !== socket.id);
        // Leeres Team loeschen (ausser es ist das einzige)
        if (oldTeam.members.length === 0 && Object.keys(session.teams).length > 1) {
          delete session.teams[player.teamId];
        }
      }

      if (teamId === "new" || !session.teams[teamId]) {
        // Neues Team erstellen
        const newId = "team-" + (Object.keys(session.teams).length + 1);
        const defaultName = "Team " + String.fromCharCode(64 + Object.keys(session.teams).length + 1);
        session.teams[newId] = {
          name: teamName || defaultName,
          members: [socket.id],
          creator: socket.id
        };
        player.teamId = newId;
      } else {
        // Existierendem Team beitreten
        session.teams[teamId].members.push(socket.id);
        player.teamId = teamId;
      }

      io.to(code).emit("updateLobby", session);
    });

    // Team-Namen setzen (nur der Ersteller des Teams darf es aendern)
    socket.on("setTeamName", ({ code, teamId, name }) => {
      const session = sessions[code];
      if (!session || !session.teams[teamId]) return;
      const team = session.teams[teamId];
      if (team.creator !== socket.id) return;
      if (!name || name.trim() === "") return;
      team.name = name.trim();
      io.to(code).emit("updateLobby", session);
    });

    socket.on("startGame", ({ code }) => {
      const session = sessions[code];
      if (!session || session.host !== socket.id) return;
      // Mindestens 4 Spieler fuer Team-Modus, Debug-Modus erlaubt Einzelspieler
      if (!session.settings.debugMode && session.players.length < 4) {
        socket.emit("error", "Mindestestens 4 Spieler fuer Team-Spiel erforderlich.");
        return;
      }
      // Alle Spieler muessen einem Team zugeordnet sein (außer Debug-Modus)
      if (!session.settings.debugMode) {
        const withoutTeam = session.players.filter(p => !p.teamId);
        if (withoutTeam.length > 0) {
          socket.emit("error", "Alle Spieler muessen einem Team zugeordnet sein.");
          return;
        }
        const teamCount = Object.keys(session.teams).length;
        if (teamCount < 2) {
          socket.emit("error", "Es muessen mindestens 2 Teams existieren.");
          return;
        }
      } else {
        // Debug-Modus: Einzelspieler bekommt Team A zugewiesen
        const player = session.players[0];
        if (!player.teamId) {
          if (!session.teams["team-1"]) {
            session.teams["team-1"] = { name: "Team A", members: [], creator: player.id };
          }
          session.teams["team-1"].members.push(player.id);
          player.teamId = "team-1";
        }
      }
      resetSession(session);
      session.state = "running";
      session.phase = "playing";
      session.confirmedControllerId = null;
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

    socket.on("controllerConfirm", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
      const explainer = session.players[session.currentPlayerIndex];
      if (!explainer) return;
      // Im Debug-Modus darf sich der Erklärer selbst als Kontrolleur bestaetigen
      if (!session.settings.debugMode && socket.id === explainer.id) return;
      // Bereits bestaetigt?
      if (session.confirmedControllerId === socket.id) return;
      session.confirmedControllerId = socket.id;
      session.controllerId = socket.id;
      const controller = session.players.find(p => p.id === socket.id);
      session.controller = controller ? controller.name : "Kontrolleur";
      io.to(code).emit("controllerConfirmed", {
        controllerId: socket.id,
        controllerName: session.controller
      });
    });

    socket.on("wordResult", ({ code, correct }) => {
      const session = sessions[code];
      if (!session) return;
      // Nur der bestaetigte Kontrolleur duerfen bewerten
      if (session.confirmedControllerId !== socket.id) return;
      const explainer = session.players[session.currentPlayerIndex];
      if (!explainer) return;
      if (correct) {
        explainer.score += 1;
      }
      countWord(session);
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
      countWord(session);
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
      countWord(session);
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

    // Erklärer löst den Start der Zug-Runde selbst aus – nur wenn ein Kontrolleur bestätigt wurde.
    socket.on("turnReady", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
      const explainer = session.players[session.currentPlayerIndex];
      if (!explainer || socket.id !== explainer.id) return;
      if (!session.confirmedControllerId) return; // Kein Kontrolleur bestätigt
      beginTurn(code, io);
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

        // Spieler aus allen Teams entfernen
        for (const teamId in session.teams) {
          const team = session.teams[teamId];
          team.members = team.members.filter(m => m !== socket.id);
          // Leeres Team loeschen (ausser es ist das einzige)
          if (team.members.length === 0 && Object.keys(session.teams).length > 1) {
            delete session.teams[teamId];
          }
        }

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
  session.controllerId = null;
  session.confirmedControllerId = null;
  session.currentLetter = null;
  session.letterSubmissions = {};
  session.currentTerm = null;
  session.currentForbidden = [];
  session.timerEndsAt = null;
  if (timerHandles[session.code]) {
    clearTimeout(timerHandles[session.code]);
    delete timerHandles[session.code];
  }
  // Teams zuruecksetzen: Spieler waehlen neu in der Lobby
  session.players.forEach(p => {
    p.score = 0;
    p.teamId = null;
  });
  session.teams = {};
}

// Startet den Zug. Im Moeser-Mamster-Modus wird zuerst der Buchstabe
// festgelegt: per Zufall oder durch Vorschlaege der Gruppe.
function startTurn(code, io) {
  const session = sessions[code];
  if (!session) return;
  session.wordsThisTurn = 0;
  const explainerIndex = session.currentPlayerIndex;
  const explainer = session.players[explainerIndex];

  // Kontrolleur muss aus dem GEGNERISCHEN Team kommen (nicht dasselbe Team wie Erklärer)
  let controller = null;
  const otherTeamPlayers = session.players.filter(
    p => p.id !== explainer.id && p.teamId !== explainer.teamId
  );
  if (otherTeamPlayers.length > 0) {
    controller = otherTeamPlayers[Math.floor(Math.random() * otherTeamPlayers.length)];
  } else {
    // Fallback: beliebiger anderer Spieler (z.B. nur 1 Team oder Debug-Modus)
    const others = session.players.filter(p => p.id !== explainer.id);
    if (others.length > 0) {
      controller = others[Math.floor(Math.random() * others.length)];
    }
  }

  session.controller = controller ? controller.name : null;
  session.controllerId = controller ? controller.id : null;

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

  // Vorbereitungs-Pause vor dem Zug: alle Spieler sehen einen bereiten Bildschirm
  prepareTurn(code, io);
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
    round: session.currentRound,
    wordsThisTurn: session.wordsThisTurn
  });
  // Bei timerScope "turn" startet die Uhr hier einmal fuer den ganzen Zug
  // und laeuft ueber alle Woerter weiter.
  if ((session.settings.timerScope || "turn") === "turn") {
    startTurnTimer(code, io, session);
  }
  // Das Wort wurde bereits in prepareTurn vorbereitet. Nur wenn kein
  // Wort gesetzt ist (z.B. direkter Aufruf ohne Pause), hier nachholen.
  if (!session.currentTerm) {
    setTimeout(() => sendNextWord(code, io), 300);
  }
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
  prepareTurn(code, io);
}

// Vorbereitungs-Pause vor einem neuen Zug. Alle Spieler bekommen einen
// rollenspezifischen Bildschirm ("mach dich bereit"). Erklärer und der
// bestaetigte Kontrolleur sehen zudem das Wort und die Tabuwörter.
// Der Erklärer löst den Start selbst per "turnReady" aus (kein automatischer Countdown).
function prepareTurn(code, io) {
  const session = sessions[code];
  if (!session) return;

  // Wort und Tabuwörter auswählen (wie sendNextWord, aber ohne Senden)
  const allWords = allSharedWords;

  let list = allWords.filter(w => !session.usedWords.includes(w.term));
  if (list.length === 0) {
    session.usedWords = [];
    list = allWords;
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

  const explainer = session.players[session.currentPlayerIndex];
  const controller = session.confirmedControllerId
    ? session.players.find(p => p.id === session.confirmedControllerId)
    : null;

  session.players.forEach(p => {
    if (p.id === explainer.id) {
      io.to(p.id).emit("turnPrepare", {
        role: "explainer",
        term: session.currentTerm,
        forbidden: session.currentForbidden,
        letter: session.currentLetter,
        message: "Du erklärst jetzt – mach dich bereit!"
      });
    } else if (controller && p.id === controller.id) {
      io.to(p.id).emit("turnPrepare", {
        role: "controller",
        term: session.currentTerm,
        forbidden: session.currentForbidden,
        letter: session.currentLetter,
        message: "Du kontrollierst jetzt – mach dich bereit!"
      });
    } else {
      io.to(p.id).emit("turnPrepare", {
        role: "guesser",
        message: "Du rätst jetzt – warte auf den Kontrolleur!"
      });
    }
  });
}

// Der Begriff geht nur an den Erklaerer, die Tabuwörter an Erklaerer und
// den bestaetigten Kontrolleur. So sieht niemand sonst den Begriff.
function sendWordToRoles(code, io, session) {
  if (!session.currentTerm) return;
  const explainer = session.players[session.currentPlayerIndex];
  const controller = session.confirmedControllerId
    ? session.players.find(p => p.id === session.confirmedControllerId)
    : null;
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
  // Votes fuer das neue Wort zuruecksetzen
  session.wordVotes = { correct: [], wrong: [] };

  // Wenn bereits ein Wort vorbereitet wurde (von prepareTurn), dieses
  // verwenden statt ein neues auszuwaehlen.
  if (!session.currentTerm) {
    const listName = session.settings.wordlist || "standard";
    const allWords = allSharedWords;

    // usedWords enthaelt die Woerter der AKTUELLEN Runde: innerhalb einer
    // Runde bekommt kein Spieler zweimal dasselbe Wort zu erklaeren.
    // Beim Rundenwechsel wird die Liste zurueckgesetzt (siehe
    // advanceToNextPlayer), dann sind die Woerter wieder frei.
    let list = allWords.filter(w => !session.usedWords.includes(w.term));

    // Alle Woerter sind schon gespielt worden. Das ist KEIN Spielende -
    // das Spielende legt allein die Einstellung "Spielende per" fest.
    // Stattdessen wird die Wortliste neu gemischt, damit es weitergeht.
    if (list.length === 0) {
      session.usedWords = [];
      list = allWords;
      io.to(code).emit("wordListRefreshed", {
        total: allWords.length
      });
    }

    // Zufallige Auswahl - der Begriff wird nicht der Reihe nach vergeben.
    const word = list[Math.floor(Math.random() * list.length)];
    session.usedWords.push(word.term);
    const tabooCount = session.settings.tabooCount || 3;
    const forbidden = word.forbidden
      .slice()
      .sort(() => Math.random() - 0.5)
      .slice(0, tabooCount);

    session.currentTerm = word.term;
    session.currentForbidden = forbidden;
  }

  sendWordToRoles(code, io, session);

  // Bei timerScope "word" startet die Uhr fuer jedes Wort neu.
  // Bei "turn" laeuft die Uhr weiter und wird hier nicht angefasst.
  if ((session.settings.timerScope || "turn") === "word") {
    startTurnTimer(code, io, session);
  }
}

// Zaehlt ein Wort fuer die Anzeige "Wort X von Y".
// Mit aktivem Timer gibt es keine Wortgrenze - der Zaehler bleibt dann
// bei 0, damit die Anzeige nicht eine Begrenzung vortaeuscht, die es
// nicht gibt.
function countWord(session) {
  if (session.settings.timer) return;
  session.wordsThisTurn += 1;
}

function checkTurnEnd(code, io) {
  const session = sessions[code];
  if (!session) return;
  // Wortzaehler melden (nur ohne Timer sinnvoll - mit Timer gibt es
  // keine Wortgrenze)
  io.to(code).emit("wordProgress", { wordsThisTurn: session.wordsThisTurn });
  // Mit aktivem Timer ist die Zahl der Woerter pro Runde unbegrenzt:
  // der Zug endet ausschliesslich, wenn der Timer ablaeuft.
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
  // Kontrolleur-Bestaetigung fuer neuen Zug zuruecksetzen
  session.confirmedControllerId = null;
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
  // Wortliste fuer die neue Runde freigeben: in der neuen Runde darf
  // jedes Wort erneut vergeben werden - innerhalb einer Runde nicht.
  session.usedWords = [];
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
