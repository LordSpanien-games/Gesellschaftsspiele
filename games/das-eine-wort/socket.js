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
      sessions[code] = {
        host: socket.id,
        config,
        players: [{ id: socket.id, name, score: 0 }],
        state: "lobby",
        round: 0,
        words: [],
        currentGuesser: 0,
        hints: {},
        eliminated: [],
        hintsDone: [],
        readyForReview: [],
        readyForGuess: [],
        results: []
      };
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = name;
      socket.emit("roomCreated", { code, config });
      io.to(code).emit("lobbyUpdate", sessions[code].players);
    });

    socket.on("joinRoom", ({ code, name }) => {
      const session = sessions[code];
      if (!session) return socket.emit("error", "Raum nicht gefunden.");
      if (session.state !== "lobby") return socket.emit("error", "Spiel laeuft bereits.");
      session.players.push({ id: socket.id, name, score: 0 });
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = name;
      socket.emit("joinedRoom", { code, config: session.config });
      io.to(code).emit("lobbyUpdate", session.players);
    });

    socket.on("startGame", () => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session || session.host !== socket.id) return;
      const totalWords = session.config.rounds * session.config.wordsPerRound;
      session.words = getWords(totalWords);
      session.state = "playing";
      session.round = 0;
      session.currentGuesser = 0;
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
      session.votes = { correct: [], wrong: [] };

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

    socket.on("voteResult", ({ correct }) => {
      const code = socket.roomCode;
      const session = sessions[code];
      if (!session) return;
      // Nur Nicht-Rater (die "Kontrolleure" der Begriffe) dürfen voten, jeder einmal
      if (socket.id === session.guesserSocketId) return;
      if (session.votes.correct.includes(socket.id) || session.votes.wrong.includes(socket.id)) return;
      if (correct) {
        session.votes.correct.push(socket.id);
      } else {
        session.votes.wrong.push(socket.id);
      }

      const nonGuessers = session.players.filter(p => p.id !== session.guesserSocketId);
      const voted = session.votes.correct.length + session.votes.wrong.length;

      // Fortschritt an alle
      io.to(code).emit("voteProgress", { done: voted, total: nonGuessers.length });

      // Wenn alle Nicht-Rater gevotet haben -> Mehrheit entscheidet (Gleichstand = falsch)
      if (voted >= nonGuessers.length) {
        const result = session.votes.correct.length >= session.votes.wrong.length;
        if (result) {
          const guesser = session.players.find(p => p.id === session.guesserSocketId);
          if (guesser) guesser.score += 1;
        }
        session.results.push({
          round: session.round + 1,
          word: session.currentWord,
          correct: result
        });
        session.round++;
        session.currentGuesser++;
        startRound(code);
      }
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
      io.to(code).emit("playerDisconnected", { name: socket.playerName });
    });

  });
};