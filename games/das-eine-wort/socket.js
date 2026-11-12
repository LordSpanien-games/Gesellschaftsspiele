const fs = require("fs");
const path = require("path");

const wordsPath = path.join(__dirname, "..", "shared", "data", "wordlist.json");
const shared = JSON.parse(fs.readFileSync(wordsPath, "utf8"));
let wordList = shared.words.map(w => w.term);

const sessions = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getWords(count) {
  const shuffled = [...wordList].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

module.exports = (io) => {
  io.on("connection", (socket) => {

    socket.on("createRoom", ({ name, config }) => {
      const code = generateCode();
      // Nur noch Team-Modus. Debug-Modus erlaubt Einzelspieler-Test.
      config.mode = "team";
      sessions[code] = {
        host: socket.id,
        config,
        players: [{ id: socket.id, name, score: 0, teamId: "team-1" }],
        teams: {
          "team-1": { name: "Team A", members: ["team-1-host-marker"] }
        },
        state: "lobby",
        round: 0,
        words: [],
        currentGuesser: 0,
        hints: {},
        eliminated: [],
        hintsDone: [],
        readyForReview: [],
        readyForGuess: [],
        results: [],
        confirmedControllerId: null,
      };
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = name;
      socket.emit("roomCreated", { code, config });
      io.to(code).emit("lobbyUpdate", session);
    });

    socket.on("joinRoom", ({ code, name }) => {
      const session = sessions[code];
      if (!session) return socket.emit("error", "Raum nicht gefunden.");
      if (session.state !== "lobby") return socket.emit("error", "Spiel laeuft bereits.");
      // Spieler kommt erst ohne Team - er waehlt selbst in der Lobby
      session.players.push({ id: socket.id, name, score: 0, teamId: null });
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = name;
      socket.emit("joinedRoom", { code, config: session.config });
      io.to(code).emit("lobbyUpdate", session);
    });

    socket.on("startGame", () => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session || session.host !== socket.id) return;
      // Mindestens 4 Spieler fuer Team-Modus, Debug-Modus erlaubt Einzelspieler
      if (!session.config.debugMode && session.players.length < 4) {
        socket.emit("error", "Mindestestens 4 Spieler fuer Team-Spiel erforderlich.");
        return;
      }
      // Alle Spieler muessen einem Team zugeordnet sein (außer Debug-Modus)
      if (!session.config.debugMode) {
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
        const player = session.players[0];
        if (!player.teamId) {
          if (!session.teams["team-1"]) {
            session.teams["team-1"] = { name: "Team A", members: [], creator: player.id };
          }
          session.teams["team-1"].members.push(player.id);
          player.teamId = "team-1";
        }
      }
      const totalWords = session.config.rounds * session.config.wordsPerRound;
      session.words = getWords(totalWords);
      session.state = "playing";
      session.round = 0;
      session.currentGuesser = 0;
      session.confirmedControllerId = null;
      prepareRound(code);
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
        if (oldTeam.members.length === 0 && Object.keys(session.teams).length > 1) {
          delete session.teams[player.teamId];
        }
      }

      if (teamId === "new" || !session.teams[teamId]) {
        const newId = "team-" + (Object.keys(session.teams).length + 1);
        const defaultName = "Team " + String.fromCharCode(64 + Object.keys(session.teams).length + 1);
        session.teams[newId] = {
          name: teamName || defaultName,
          members: [socket.id],
          creator: socket.id
        };
        player.teamId = newId;
      } else {
        session.teams[teamId].members.push(socket.id);
        player.teamId = teamId;
      }

      io.to(code).emit("lobbyUpdate", session);
    });

    // Team-Namen setzen (nur der Ersteller des Teams darf es aendern)
    socket.on("setTeamName", ({ code, teamId, name }) => {
      const session = sessions[code];
      if (!session || !session.teams[teamId]) return;
      const team = session.teams[teamId];
      if (team.creator !== socket.id) return;
      if (!name || name.trim() === "") return;
      team.name = name.trim();
      io.to(code).emit("lobbyUpdate", session);
    });

    // Vorbereitungs-Pause vor einer neuen Runde: alle Spieler sehen einen
    // rollenspezifischen "mach dich bereit"-Bildschirm. Der Rater löst den
    // Start selbst per "roundReady" aus (kein automatischer Countdown).
    function prepareRound(code) {
      const session = sessions[code];
      if (!session) return;

      const guesserIndex = session.currentGuesser % session.players.length;
      const guesser = session.players[guesserIndex];
      const word = session.words[session.round];

      session.confirmedControllerId = null;

      session.players.forEach(p => {
        if (p.id === guesser.id) {
          io.to(p.id).emit("roundPrepare", {
            role: "guesser",
            round: session.round + 1,
            totalRounds: session.config.rounds,
            message: "Du rätst jetzt – warte auf den Kontrolleur!"
          });
        } else {
          io.to(p.id).emit("roundPrepare", {
            role: "hintGiver",
            round: session.round + 1,
            totalRounds: session.config.rounds,
            word: word,
            message: "Du gibst Hinweise – mach dich bereit!"
          });
        }
      });
    }

    // Ein Nicht-Raeter bestaetigt sich als Kontrolleur fuer diese Runde.
    socket.on("controllerConfirm", () => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      const guesserIndex = session.currentGuesser % session.players.length;
      const guesser = session.players[guesserIndex];
      if (!guesser) return;
      const player = session.players.find(p => p.id === socket.id);
      if (!player) return;
      // Nur Nicht-Raeter duerfen sich als Kontrolleur bestaetigen
      if (socket.id === guesser.id) return;
      // Kontrolleur muss aus gegnerischem Team kommen (außer Debug-Modus)
      if (!session.config.debugMode && player.teamId === guesser.teamId) return;
      if (session.confirmedControllerId === socket.id) return;
      session.confirmedControllerId = socket.id;
      const controller = session.players.find(p => p.id === socket.id);
      io.to(code).emit("controllerConfirmed", {
        controllerId: socket.id,
        controllerName: controller ? controller.name : "Kontrolleur"
      });
    });

    // Rater löst den Start der Runde selbst aus – nur nach Kontrolleur-Bestaetigung.
    socket.on("roundReady", () => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      const guesserIndex = session.currentGuesser % session.players.length;
      const guesser = session.players[guesserIndex];
      if (!guesser || socket.id !== guesser.id) return;
      if (!session.confirmedControllerId) return; // Kein Kontrolleur bestätigt
      startRound(code);
    });

    function startRound(code) {
      const session = sessions[code];
      if (session.round >= session.config.rounds) {
        endGame(code);
        return;
      }
      session.hints = {};
      session.eliminated = [];
      session.hintsDone = [];
      session.readyForReview = [];
      session.readyForGuess = [];

      const guesserIndex = session.currentGuesser % session.players.length;
      const guesser = session.players[guesserIndex];
      const word = session.words[session.round];
      session.currentWord = word;
      session.guesserSocketId = guesser.id;

      session.players.forEach(p => {
        if (p.id === guesser.id) {
          io.to(p.id).emit("roundStart", {
            round: session.round + 1,
            totalRounds: session.config.rounds,
            isGuesser: true,
            guesserName: guesser.name,
            timerSeconds: session.config.timer
          });
        } else {
          io.to(p.id).emit("roundStart", {
            round: session.round + 1,
            totalRounds: session.config.rounds,
            isGuesser: false,
            word,
            guesserName: guesser.name,
            timerSeconds: session.config.timer
          });
        }
      });
    }

    // Hinweis eingeben + OK drücken
    socket.on("submitHint", ({ hint }) => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      if (session.hintsDone.includes(socket.id)) return;
      session.hints[socket.id] = hint;
      session.hintsDone.push(socket.id);

      const nonGuessers = session.players.filter(p => p.id !== session.guesserSocketId);

      // Fortschritt anzeigen: X von Y haben OK gedrückt
      io.to(code).emit("hintProgress", {
        done: session.hintsDone.length,
        total: nonGuessers.length
      });

      // Wenn alle OK gedrückt haben → LOS-Phase starten
      if (session.hintsDone.length >= nonGuessers.length) {
        const hintList = Object.entries(session.hints).map(([id, h]) => {
          const player = session.players.find(p => p.id === id);
          return { playerId: id, playerName: player ? player.name : "?", hint: h };
        }).sort((a, b) => a.hint.localeCompare(b.hint));

        // Alle außer Rater bekommen die Hinweise zur Prüfung
        session.players.forEach(p => {
          if (p.id !== session.guesserSocketId) {
            io.to(p.id).emit("showHintsForReview", { hints: hintList });
          }
        });

        // Rater bekommt Wartebildschirm
        io.to(session.guesserSocketId).emit("waitForReview");
      }
    });

    // Jeder kann Duplikate markieren - wird an alle gesynct
    socket.on("toggleEliminate", ({ playerId }) => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      if (session.eliminated.includes(playerId)) {
        session.eliminated = session.eliminated.filter(e => e !== playerId);
      } else {
        session.eliminated.push(playerId);
      }
      // Sync an alle Mitspieler außer Rater
      session.players.forEach(p => {
        if (p.id !== session.guesserSocketId) {
          io.to(p.id).emit("eliminateUpdate", { eliminated: session.eliminated });
        }
      });
    });

    // Jeder drückt LOS in der Review-Phase
    socket.on("submitEliminated", () => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      if (session.readyForGuess.includes(socket.id)) return;
      session.readyForGuess.push(socket.id);

      const nonGuessers = session.players.filter(p => p.id !== session.guesserSocketId);

      // Fortschritt anzeigen
      io.to(code).emit("losProgress", {
        done: session.readyForGuess.length,
        total: nonGuessers.length
      });

      // Wenn alle LOS gedrückt haben → Ratender bekommt die Hinweise
      if (session.readyForGuess.length >= nonGuessers.length) {
        const remaining = Object.entries(session.hints)
          .filter(([id]) => !session.eliminated.includes(id))
          .map(([, h]) => h);
        io.to(session.guesserSocketId).emit("showHintsToGuess", { hints: remaining });
        io.to(code).emit("guessingPhase");
      }
    });

    socket.on("submitGuess", ({ guess }) => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      io.to(code).emit("guessSubmitted", { guess, word: session.currentWord });
    });

    // Nur der bestaetigte Kontrolleur duerfen bewerten (keine Mehrheit mehr)
    socket.on("voteResult", ({ correct }) => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      // Nur der bestaetigte Kontrolleur duerfen bewerten
      if (session.confirmedControllerId !== socket.id) return;
      const guesserIndex = session.currentGuesser % session.players.length;
      const guesser = session.players[guesserIndex];
      if (!guesser) return;
      if (correct) {
        guesser.score += 1;
      }
      session.results.push({
        round: session.round + 1,
        word: session.currentWord,
        correct: correct
      });
      session.round++;
      session.currentGuesser++;
      prepareRound(code);
    });

    function endGame(code) {
      const session = sessions[code];
      const totalRounds = session.config.rounds;
      const correctCount = session.results.filter(r => r.correct).length;
      const percentage = correctCount / totalRounds;
      let threshold = 0.5;
      if (session.config.difficulty === "leicht") threshold = 0.6;
      if (session.config.difficulty === "schwer") threshold = 0.7;
      const won = percentage >= threshold;
      const scoreboard = [...session.players]
        .sort((a, b) => b.score - a.score)
        .map(p => ({ name: p.name, score: p.score }));
      io.to(code).emit("gameOver", {
        won,
        correct: correctCount,
        total: totalRounds,
        scoreboard,
        results: session.results
      });
      session.state = "finished";
    }

    socket.on("rejoin", ({ code, name }) => {
      const session = sessions[code];
      if (!session) return socket.emit("error", "Raum nicht gefunden.");
      const player = session.players.find(p => p.name === name);
      if (player) {
        player.id = socket.id;
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = name;
        socket.emit("rejoined", { config: session.config, state: session.state });
      }
    });

    socket.on("disconnect", () => {
      const code = socket.roomCode;
      if (!code || !sessions[code]) return;
      const session = sessions[code];
      session.players = session.players.filter(p => p.id !== socket.id);

      // Spieler aus allen Teams entfernen
      for (const teamId in session.teams) {
        const team = session.teams[teamId];
        team.members = team.members.filter(m => m !== socket.id);
        if (team.members.length === 0 && Object.keys(session.teams).length > 1) {
          delete session.teams[teamId];
        }
      }

      io.to(code).emit("playerDisconnected", { name: socket.playerName });
    });

  });
};