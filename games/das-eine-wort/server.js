const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(express.static(path.join(__dirname, "public")));

// Wortliste laden
const wordsPath = path.join(__dirname, "data", "words.json");
let wordList = JSON.parse(fs.readFileSync(wordsPath, "utf8"));

// Sessions im RAM
const sessions = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getWords(count) {
  const shuffled = [...wordList].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

io.on("connection", (socket) => {

  // Raum erstellen
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
      results: []
    };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    socket.emit("roomCreated", { code, config });
    io.to(code).emit("lobbyUpdate", sessions[code].players);
  });

  // Raum beitreten
  socket.on("joinRoom", ({ code, name }) => {
    const session = sessions[code];
    if (!session) return socket.emit("error", "Raum nicht gefunden.");
    if (session.state !== "lobby") return socket.emit("error", "Spiel läuft bereits.");

    session.players.push({ id: socket.id, name, score: 0 });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    socket.emit("joinedRoom", { code, config: session.config });
    io.to(code).emit("lobbyUpdate", session.players);
  });

  // Spiel starten
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

    const guesserIndex = session.currentGuesser % session.players.length;
    const guesser = session.players[guesserIndex];
    const word = session.words[session.round];

    session.currentWord = word;
    session.guesserSocketId = guesser.id;

    // Alle außer Rater bekommen das Wort
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

  // Hinweis eingeben
  socket.on("submitHint", ({ hint }) => {
    const code = socket.roomCode;
    const session = sessions[code];
    if (!session) return;

    session.hints[socket.id] = hint;
    session.hintsDone.push(socket.id);

    const nonGuessers = session.players.filter(p => p.id !== session.guesserSocketId);

    if (session.hintsDone.length >= nonGuessers.length) {
      // Alle Hinweise gesammelt → alphabetisch sortiert an alle (außer Rater)
      const hintList = Object.entries(session.hints).map(([id, h]) => {
        const player = session.players.find(p => p.id === id);
        return { playerId: id, playerName: player ? player.name : "?", hint: h };
      }).sort((a, b) => a.hint.localeCompare(b.hint));

      session.players.forEach(p => {
        if (p.id !== session.guesserSocketId) {
          io.to(p.id).emit("showHintsForReview", { hints: hintList });
        }
      });
    }
  });

  // Duplikate markieren → Los drücken
  socket.on("submitEliminated", ({ eliminatedIds }) => {
    const code = socket.roomCode;
    const session = sessions[code];
    if (!session || socket.id !== session.host) return;

    const remaining = Object.entries(session.hints)
      .filter(([id]) => !eliminatedIds.includes(id))
      .map(([id, h]) => h);

    // Ratenden bekommt verbleibende Hinweise
    io.to(session.guesserSocketId).emit("showHintsToGuess", { hints: remaining });
    io.to(code).emit("guessingPhase");
  });

  // Antwort des Ratenden
  socket.on("submitGuess", ({ guess }) => {
    const code = socket.roomCode;
    const session = sessions[code];
    if (!session) return;
    io.to(code).emit("guessSubmitted", { guess, word: session.currentWord });
  });

  // Gruppe bewertet
  socket.on("voteResult", ({ correct }) => {
    const code = socket.roomCode;
    const session = sessions[code];
    if (!session || socket.id !== session.host) return;

    if (correct) {
      const guesser = session.players.find(p => p.id === session.guesserSocketId);
      if (guesser) guesser.score += 1;
    }

    session.results.push({
      round: session.round + 1,
      word: session.currentWord,
      correct
    });

    session.round++;
    session.currentGuesser++;
    startRound(code);
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

  // Rejoin
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

  // Disconnect
  socket.on("disconnect", () => {
    const code = socket.roomCode;
    if (!code || !sessions[code]) return;
    io.to(code).emit("playerDisconnected", { name: socket.playerName });
  });

});

server.listen(PORT, () => {
  console.log(`Das eine Wort läuft auf Port ${PORT}`);
});

