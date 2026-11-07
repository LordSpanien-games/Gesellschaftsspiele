const socket = io("/so-aber-anders");
let sessionCode = null;
let playerName = null;
let isHost = false;

// Rejoin nach Nochmal spielen
const params = new URLSearchParams(window.location.search);
if (params.get("rejoin") === "true") {
  sessionCode = params.get("code");
  playerName = decodeURIComponent(params.get("name"));
  isHost = params.get("host") === "true";
  socket.emit("rejoinSession", { code: sessionCode, name: playerName });
}

function showStart() {
  hide(["screen-create", "screen-join", "screen-lobby"]);
  show("screen-start");
}

function showCreate() {
  playerName = document.getElementById("player-name").value.trim();
  if (!playerName) { showError("Bitte Namen eingeben!"); return; }
  hide(["screen-start", "screen-join", "screen-lobby"]);
  show("screen-create");
}

function showJoin() {
  playerName = document.getElementById("player-name").value.trim();
  if (!playerName) { showError("Bitte Namen eingeben!"); return; }
  hide(["screen-start", "screen-create", "screen-lobby"]);
  show("screen-join");
}

function createSession() {
  const settings = {
    mode:             document.getElementById("setting-mode").value,
    rotation:         document.getElementById("setting-rotation").value,
    timer:            document.getElementById("setting-timer").value === "on",
    timerDuration:    parseInt(document.getElementById("setting-timer-duration").value),
    taboo:            document.getElementById("setting-taboo").value === "on",
    tabooCount:       parseInt(document.getElementById("setting-taboo-count").value),
    skipAllowed:      document.getElementById("setting-skip").value === "on",
    minusOnSkip:      document.getElementById("setting-minus-skip").value === "on",
    minusOnViolation: document.getElementById("setting-minus-violation").value === "on",
    endMode:          document.getElementById("setting-endmode").value,
    rounds:           parseInt(document.getElementById("setting-rounds").value),
    targetScore:      parseInt(document.getElementById("setting-target-score").value),
    wordsPerRound:    parseInt(document.getElementById("setting-words-per-round").value),
    wordlist:         document.getElementById("setting-wordlist").value
  };
  socket.emit("createSession", { name: playerName, settings });
}

function joinSession() {
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!code) { showError("Bitte Code eingeben!"); return; }
  sessionCode = code;
  socket.emit("joinSession", { code, name: playerName });
}

function startGame() {
  socket.emit("startGame", { code: sessionCode });
}

socket.on("sessionCreated", (data) => {
  sessionCode = data.code;
  isHost = true;
  document.getElementById("session-code-display").textContent = sessionCode;
  document.getElementById("btn-start").style.display = "block";
  hide(["screen-start", "screen-create", "screen-join"]);
  show("screen-lobby");
});

socket.on("updateLobby", (session) => {
  sessionCode = session.code;
  document.getElementById("session-code-display").textContent = session.code;
  const list = document.getElementById("player-list");
  list.innerHTML = "<h2>👥 Spieler</h2>";
  session.players.forEach(p => {
    const div = document.createElement("div");
    div.textContent = p.name + (p.id === session.host ? " 👑" : "");
    list.appendChild(div);
  });
  if (isHost) {
    document.getElementById("btn-start").style.display = "block";
  }
  hide(["screen-start", "screen-create", "screen-join"]);
  show("screen-lobby");
});

socket.on("gameStarted", () => {
  window.location.href = "game.html?code=" + sessionCode +
    "&name=" + encodeURIComponent(playerName) +
    "&host=" + isHost;
});

socket.on("error", (msg) => showError(msg));

function show(id) {
  document.getElementById(id).style.display = "block";
}

function hide(ids) {
  ids.forEach(id => document.getElementById(id).style.display = "none");
}

function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  setTimeout(() => document.getElementById("error-msg").textContent = "", 3000);
}