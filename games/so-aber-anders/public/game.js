const socket = io("/so-aber-anders");
const params = new URLSearchParams(window.location.search);
const sessionCode = params.get("code");
const playerName = decodeURIComponent(params.get("name"));
const isHost = params.get("host") === "true";

let timerInterval = null;
let settings = null;

socket.emit("rejoinSession", { code: sessionCode, name: playerName });

socket.on("newTurn", (data) => {
  settings = data.settings;
  document.getElementById("round-display").textContent =
    "Runde " + data.round;
  if (data.explainer === playerName) {
    showScreen("screen-explainer");
    document.getElementById("term-display").textContent = "";
    document.getElementById("forbidden-list").innerHTML = "";
    document.getElementById("timer-display").textContent = "";
    document.getElementById("btn-skip").style.display =
      settings.skipAllowed ? "block" : "none";
  } else if (data.controller === playerName) {
    showScreen("screen-controller");
    document.getElementById("controller-forbidden").innerHTML = "";
  } else {
    showScreen("screen-waiting");
    document.getElementById("current-explainer").textContent =
      "🗣️ " + data.explainer + " erklaert gerade...";
  }
  updateScoreBoard(data.players);
});

socket.on("newWord", (data) => {
  document.getElementById("term-display").textContent = data.term;
  const forbiddenList = document.getElementById("forbidden-list");
  forbiddenList.innerHTML = "";
  if (data.forbidden && data.forbidden.length > 0) {
    forbiddenList.innerHTML = "<strong>🚫 Verbotene Woerter:</strong><br>";
    data.forbidden.forEach(w => {
      const span = document.createElement("span");
      span.className = "forbidden-word";
      span.textContent = w + " ";
      forbiddenList.appendChild(span);
    });
  }
  const ctrlForbidden = document.getElementById("controller-forbidden");
  if (ctrlForbidden) {
    ctrlForbidden.innerHTML = "";
    if (data.forbidden && data.forbidden.length > 0) {
      ctrlForbidden.innerHTML = "<strong>🚫 Achte auf diese Woerter:</strong><br>";
      data.forbidden.forEach(w => {
        const span = document.createElement("span");
        span.className = "forbidden-word";
        span.textContent = w + " ";
        ctrlForbidden.appendChild(span);
      });
    }
  }
  if (settings && settings.timer) {
    startTimer(settings.timerDuration);
  }
});

socket.on("scoreUpdate", (players) => {
  updateScoreBoard(players);
});

socket.on("roundEnd", (data) => {
  stopTimer();
  showScreen("screen-waiting");
  document.getElementById("current-explainer").textContent =
    "✅ Runde " + data.round + " beendet! Naechste Runde startet...";
  updateScoreBoard(data.players);
});

socket.on("gameOver", (players) => {
  showScreen("screen-gameover");
  stopTimer();
  const final = document.getElementById("final-score");
  final.innerHTML = "";
  const sorted = [...players].sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "score-card";
    card.innerHTML =
      "<div class='name'>" + (i === 0 ? "🏆 " : "") + p.name + "</div>" +
      "<div class='points'>" + p.score + "</div>";
    final.appendChild(card);
  });
  if (isHost) {
    document.getElementById("btn-restart").style.display = "block";
  }
});

// Zurueck zur Lobby – gleiche Session, neue Runde moeglich
socket.on("backToLobby", (session) => {
  window.location.href = "index.html?code=" + sessionCode +
    "&name=" + encodeURIComponent(playerName) +
    "&host=" + isHost +
    "&rejoin=true";
});

socket.on("error", (msg) => showError(msg));

function wordCorrect() {
  stopTimer();
  socket.emit("wordCorrect", { code: sessionCode });
}

function wordSkip() {
  stopTimer();
  socket.emit("wordSkip", { code: sessionCode });
}

function reportViolation() {
  stopTimer();
  socket.emit("violation", { code: sessionCode });
}

function restartGame() {
  socket.emit("restartGame", { code: sessionCode });
}

function startTimer(seconds) {
  stopTimer();
  let remaining = seconds;
  const display = document.getElementById("timer-display");
  display.textContent = "⏱️ " + remaining + "s";
  timerInterval = setInterval(() => {
    remaining--;
    display.textContent = "⏱️ " + remaining + "s";
    if (remaining <= 0) {
      stopTimer();
      socket.emit("timerEnd", { code: sessionCode });
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function showScreen(id) {
  ["screen-waiting","screen-explainer","screen-controller","screen-gameover"]
    .forEach(s => document.getElementById(s).style.display = "none");
  document.getElementById(id).style.display = "block";
}

function updateScoreBoard(players) {
  const board = document.getElementById("score-board");
  if (!board) return;
  board.innerHTML = "";
  players.forEach(p => {
    const card = document.createElement("div");
    card.className = "score-card";
    card.innerHTML =
      "<div class='name'>" + p.name + "</div>" +
      "<div class='points'>" + p.score + "</div>";
    board.appendChild(card);
  });
}

function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  setTimeout(() => document.getElementById("error-msg").textContent = "", 3000);
}