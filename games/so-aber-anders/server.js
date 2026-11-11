const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const sharedPath = path.join(__dirname, "..", "shared", "data", "wordlist.json");
const shared = JSON.parse(fs.readFileSync(sharedPath, "utf8"));
const allSharedWords = shared.words;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const sessions = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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
      controller: null
    };
    socket.join(code);
    socket.emit("sessionCreated", { code });
    io.to(code).emit("updateLobby", sessions[code]);
  });

  socket.on("joinSession", ({ code, name }) => {
    const session = sessions[code];
    if (!session || session.state !== "lobby") {
      socket.emit("error", "Session nicht gefunden oder bereits gestartet");
      return;
    }
    session.players.push({ id: socket.id, name, score: 0 });
    socket.join(code);
    io.to(code).emit("updateLobby", session);
  });

  socket.on("startGame", ({ code }) => {
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;
    session.state = "running";
    session.currentPlayerIndex = 0;
    io.to(code).emit("gameStarted", session);
    nextTurn(code);
  });

  socket.on("wordResult", ({ code, correct }) => {
    const session = sessions[code];
    if (!session) return;
    if (correct) {
      session.players[session.currentPlayerIndex].score += 1;
    }
    io.to(code).emit("scoreUpdate", session.players);
    nextWord(code);
  });

  socket.on("wordSkip", ({ code }) => {
    const session = sessions[code];
    if (!session) return;
    if (session.settings.minusOnSkip) {
      session.players[session.currentPlayerIndex].score -= 1;
    }
    io.to(code).emit("scoreUpdate", session.players);
    nextWord(code);
  });

  socket.on("violation", ({ code }) => {
    const session = sessions[code];
    if (!session) return;
    if (session.settings.minusOnViolation) {
      session.players[session.currentPlayerIndex].score -= 1;
    }
    io.to(code).emit("scoreUpdate", session.players);
    nextWord(code);
  });

  socket.on("timerEnd", ({ code }) => {
    const session = sessions[code];
    if (!session) return;
    nextTurn(code);
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
      socket.emit("newTurn", {
        explainer: session.players[session.currentPlayerIndex].name,
        controller: session.controller || null,
        players: session.players,
        settings: session.settings
      });
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

function nextWord(code) {
  const session = sessions[code];
  const listName = session.settings.wordlist || "standard";
  const list = allSharedWords.filter(
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

function nextTurn(code) {
  const session = sessions[code];
  session.currentPlayerIndex =
    (session.currentPlayerIndex + 1) % session.players.length;

  // Kontrolleur bestimmen (anderes Team / naechster Spieler)
  const explainerIndex = session.currentPlayerIndex;
  const controllerIndex = (explainerIndex + 1) % session.players.length;
  session.controller = session.players[controllerIndex].name;

  io.to(code).emit("newTurn", {
    explainer: session.players[explainerIndex].name,
    controller: session.controller,
    players: session.players,
    settings: session.settings
  });
  nextWord(code);
}

server.listen(3000, () => {
  console.log("So aber anders laeuft auf http://localhost:3000");
});