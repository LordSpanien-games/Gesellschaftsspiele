const fs = require("fs");
const path = require("path");

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

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
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
        state: "lobby",
        currentPlayerIndex: 0,
        currentRound: 1,
        wordsThisTurn: 0,
        controller: null
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
      io.to(code).emit("gameStarted", session);
      setTimeout(() => startTurn(code, io), 500);
    });

    socket.on("restartGame", ({ code }) => {
      const session = sessions[code];
      if (!session || session.host !== socket.id) return;
      // Zurueck in Lobby – neue Spieler koennen beitreten
      session.state = "lobby";
      session.players.forEach(p => p.score = 0);
      resetSession(session);
      io.to(code).emit("backToLobby", session);
    });

    socket.on("wordCorrect", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
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
      const player = session.players[session.currentPlayerIndex];
      if (!player) return;
      if (session.settings.minusOnSkip) {
        player.score -= 1;
      }
      session.wordsThisTurn += 1;
      io.to(code).emit("scoreUpdate", session.players);
      checkTurnEnd(code, io);
    });

    socket.on("violation", ({ code }) => {
      const session = sessions[code];
      if (!session) return;
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
      advanceToNextPlayer(code, io);
    });

    socket.on("rejoinSession", ({ code, name }) => {
      const session = sessions[code];
      if (!session) {
        socket.emit("error", "Session nicht gefunden");
        return;
      }
      const player = session.players.find(p => p.name === name);
      if (player) {
        player.id = socket.id;
        socket.join(code);
        if (session.state === "lobby") {
          io.to(code).emit("updateLobby", session);
        } else {
          socket.emit("newTurn", {
            explainer: session.players[session.currentPlayerIndex].name,
            controller: session.controller || null,
            players: session.players,
            settings: session.settings,
            round: session.currentRound
          });
        }
      }
    });

    socket.on("disconnect", () => {
      for (const code in sessions) {
        const session = sessions[code];
        session.players = session.players.filter(p => p.id !== socket.id);
        if (session.players.length === 0) {
          delete sessions[code];
        } else {
          io.to(code).emit("updateLobby", session);
        }
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
  session.players.forEach(p => p.score = 0);
}

function startTurn(code, io) {
  const session = sessions[code];
  if (!session) return;
  session.wordsThisTurn = 0;
  const explainerIndex = session.currentPlayerIndex;
  const controllerIndex = (explainerIndex + 1) % session.players.length;
  session.controller = session.players[controllerIndex].name;
  io.to(code).emit("newTurn", {
    explainer: session.players[explainerIndex].name,
    controller: session.controller,
    players: session.players,
    settings: session.settings,
    round: session.currentRound
  });
  setTimeout(() => sendNextWord(code, io), 300);
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
    .sort(() => Math.random() - 0.5)
    .slice(0, tabooCount);
  io.to(code).emit("newWord", { term: word.term, forbidden });
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