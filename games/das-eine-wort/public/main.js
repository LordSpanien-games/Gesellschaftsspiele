const socket = io("/das-eine-wort");
let roomCode = "";
let isHost = false;
let isGuesser = false;
let timerInterval = null;

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function createRoom() {
  const name = document.getElementById("playerName").value.trim();
  if (!name) return alert("Bitte Namen eingeben.");
  const config = {
    rounds: parseInt(document.getElementById("cfg-rounds").value),
    wordsPerRound: parseInt(document.getElementById("cfg-words").value),
    timer: parseInt(document.getElementById("cfg-timer").value),
    difficulty: document.getElementById("cfg-difficulty").value,
    mode: document.getElementById("cfg-mode").value
  };
  socket.emit("createRoom", { name, config });
}

function joinRoom() {
  const name = document.getElementById("playerName").value.trim();
  const code = document.getElementById("joinCode").value.trim().toUpperCase();
  if (!name) return alert("Bitte Namen eingeben.");
  if (!code) return alert("Bitte Raumcode eingeben.");
  socket.emit("joinRoom", { code, name });
}

function startGame() {
  socket.emit("startGame");
}

function submitHint() {
  const hint = document.getElementById("hint-input").value.trim();
  if (!hint) return alert("Bitte Hinweis eingeben.");
  socket.emit("submitHint", { hint });
  document.getElementById("hint-input").disabled = true;
  document.querySelector("#hint-input-area button").disabled = true;
}

function toggleEliminate(playerId) {
  socket.emit("toggleEliminate", { playerId });
}

// Jeder drueckt LOS
function submitEliminated() {
  socket.emit("submitEliminated");
  document.getElementById("btn-los").disabled = true;
  document.getElementById("btn-los").textContent = "✅ Warte auf andere...";
}

function submitGuess() {
  const guess = document.getElementById("guess-input").value.trim();
  if (!guess) return alert("Bitte Antwort eingeben.");
  socket.emit("submitGuess", { guess });
  document.getElementById("guess-input-area").style.display = "none";
}

function voteResult(correct) {
  socket.emit("voteResult", { correct });
}

function startTimer(seconds) {
  clearInterval(timerInterval);
  if (!seconds || seconds <= 0) return;
  let remaining = seconds;
  const display = document.getElementById("timer-display");
  display.textContent = "⏱ " + remaining + "s";
  timerInterval = setInterval(() => {
    remaining--;
    display.textContent = "⏱ " + remaining + "s";
    if (remaining <= 0) {
      clearInterval(timerInterval);
      display.textContent = "⏱ Zeit abgelaufen!";
      const btn = document.querySelector("#hint-input-area button");
      if (btn && !btn.disabled) submitHint();
    }
  }, 1000);
}

// SOCKET EVENTS

socket.on("roomCreated", ({ code, config }) => {
  roomCode = code;
  isHost = true;
  document.getElementById("display-code").textContent = code;
  document.getElementById("waiting-info").textContent =
    "Modus: " + config.mode +
    " | Runden: " + config.rounds +
    " | Timer: " + (config.timer === 0 ? "∞" : config.timer + "s") +
    " | Schwierigkeit: " + config.difficulty;
  document.getElementById("btn-start").style.display = "block";
  showScreen("screen-waiting");
});

socket.on("joinedRoom", ({ code, config }) => {
  roomCode = code;
  isHost = false;
  document.getElementById("display-code").textContent = code;
  document.getElementById("waiting-info").textContent =
    "Modus: " + config.mode +
    " | Runden: " + config.rounds +
    " | Timer: " + (config.timer === 0 ? "∞" : config.timer + "s");
  document.getElementById("btn-start").style.display = "none";
  showScreen("screen-waiting");
});

socket.on("lobbyUpdate", (players) => {
  const list = document.getElementById("player-list");
  list.innerHTML = players.map(p => "<li>👤 " + p.name + "</li>").join("");
});

// Vorbereitungs-Pause: rollenspezifischer "mach dich bereit"-Bildschirm
socket.on("roundPrepare", (data) => {
  document.getElementById("prepare-title").textContent = "🔄 Runde vorbereiten";
  document.getElementById("prepare-message").textContent = data.message;

  // Nur Nicht-Rater sehen das zu ratende Wort
  if (data.role === "hintGiver" && data.word) {
    document.getElementById("prepare-word").style.display = "block";
    document.getElementById("prepare-term").textContent = data.word;
  } else {
    document.getElementById("prepare-word").style.display = "none";
  }

  showScreen("screen-prepare");

  // Rater: LOS-Button zum manuellen Start. Alle anderen: Warte-Anzeige.
  const timerEl = document.getElementById("prepare-timer");
  const btnContainer = document.getElementById("btn-prepare-container");
  if (!btnContainer) {
    const container = document.createElement("div");
    container.id = "btn-prepare-container";
    container.style.marginTop = "20px";
    document.getElementById("screen-prepare").querySelector(".card").appendChild(container);
  }
  document.getElementById("btn-prepare-container").innerHTML = "";

  if (data.role === "guesser") {
    timerEl.textContent = "";
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "🚀 LOS – Runde starten";
    btn.onclick = () => socket.emit("roundReady");
    document.getElementById("btn-prepare-container").appendChild(btn);
  } else {
    timerEl.textContent = "Warte auf den Ratenden, bis die Runde startet...";
  }
});

// Manuell weiter zur Runde (wenn alle bereit sind)
function continueGame() {
  document.getElementById("screen-prepare").style.display = "none";
  // Der Server schickt in Kürze "roundStart", der dann den echten Rundenbildschirm zeigt.
}

socket.on("roundStart", ({ round, totalRounds, isGuesser: ig, word, guesserName, timerSeconds }) => {
  isGuesser = ig;
  clearInterval(timerInterval);
  document.getElementById("timer-display").textContent = "";
  document.getElementById("round-num").textContent = round;
  document.getElementById("round-total").textContent = totalRounds;

  if (isGuesser) {
    document.getElementById("round-role").textContent = "🎯 Du bist der Ratende!";
    document.getElementById("word-display").style.display = "none";
    document.getElementById("hint-input-area").style.display = "none";
    document.getElementById("guesser-waiting").style.display = "block";
    document.getElementById("guesser-waiting").textContent = "⏳ Mitspieler schreiben ihre Hinweise...";
  } else {
    document.getElementById("round-role").textContent = "🤫 " + guesserName + " raet – gib einen Hinweis!";
    document.getElementById("secret-word").textContent = word;
    document.getElementById("word-display").style.display = "block";
    document.getElementById("hint-input").value = "";
    document.getElementById("hint-input").disabled = false;
    const btn = document.querySelector("#hint-input-area button");
    if (btn) { btn.disabled = false; btn.textContent = "OK"; }
    document.getElementById("hint-input-area").style.display = "block";
    document.getElementById("guesser-waiting").style.display = "none";
    startTimer(timerSeconds);
  }
  showScreen("screen-round");
});

// Fortschritt OK-Phase
socket.on("hintProgress", ({ done, total }) => {
  document.getElementById("timer-display").textContent = "✅ " + done + " von " + total + " bereit";
});

// Rater wartet auf Review
socket.on("waitForReview", () => {
  document.getElementById("guesser-waiting").style.display = "block";
  document.getElementById("guesser-waiting").textContent = "⏳ Mitspieler prüfen die Hinweise...";
  showScreen("screen-round");
});

socket.on("showHintsForReview", ({ hints }) => {
  const list = document.getElementById("hints-review-list");
  list.innerHTML = hints.map(h =>
    '<li class="hint-item" id="hint-' + h.playerId +
    '" data-playerid="' + h.playerId +
    '" onclick="toggleEliminate(\'' + h.playerId + '\')">' +
    '📝 <strong>' + h.playerName + ':</strong> ' + h.hint +
    '</li>'
  ).join("");

  // LOS Button fuer alle zuruecksetzen
  const btn = document.getElementById("btn-los");
  btn.disabled = false;
  btn.textContent = "LOS!";
  document.getElementById("los-progress").textContent = "";
  showScreen("screen-review");
});

// Sync Markierungen von Server an alle
socket.on("eliminateUpdate", ({ eliminated }) => {
  document.querySelectorAll(".hint-item[data-playerid]").forEach(el => {
    const id = el.dataset.playerid;
    if (eliminated.includes(id)) {
      el.classList.add("eliminated");
    } else {
      el.classList.remove("eliminated");
    }
  });
});

// Fortschritt LOS-Phase
socket.on("losProgress", ({ done, total }) => {
  document.getElementById("los-progress").textContent = "✅ " + done + " von " + total + " bereit";
});

// Vote-Fortschritt (Richtig/Falsch)
socket.on("voteProgress", ({ done, total }) => {
  document.getElementById("los-progress").textContent = "✅ " + done + " von " + total + " haben bewertet";
});

socket.on("showHintsToGuess", ({ hints }) => {
  const container = document.getElementById("hints-for-guesser");
  container.innerHTML = "<h3>Deine Hinweise:</h3>" +
    hints.map(h => '<div class="hint-item">💡 ' + h + '</div>').join("");
  document.getElementById("guess-input").value = "";
  document.getElementById("guess-input-area").style.display = "block";
  document.getElementById("vote-area").style.display = "none";
  showScreen("screen-guess");
});

socket.on("guessingPhase", () => {
  if (!isGuesser) {
    document.getElementById("hints-for-guesser").innerHTML =
      "<p>⏳ Warte auf Antwort des Ratenden...</p>";
    document.getElementById("guess-input-area").style.display = "none";
    document.getElementById("vote-area").style.display = "none";
    showScreen("screen-guess");
  }
});

socket.on("guessSubmitted", ({ guess, word }) => {
  document.getElementById("guess-display").textContent = guess;
  document.getElementById("word-reveal").textContent = word;
  document.getElementById("vote-area").style.display = "block";
  // Alle außer dem Ratenden sehen die Bewertungs-Buttons
  const buttons = document.querySelectorAll("#vote-area button");
  buttons.forEach(b => b.style.display = !isGuesser ? "block" : "none");
});

socket.on("gameOver", ({ won, correct, total, scoreboard, results }) => {
  document.getElementById("result-title").textContent = won ? "🎉 Gewonnen!" : "😞 Verloren!";
  document.getElementById("result-score").textContent =
    correct + " von " + total + " Begriffen erraten.";
  document.getElementById("scoreboard").innerHTML =
    scoreboard.map(p => "<li>" + p.name + ": " + p.score + " Punkte</li>").join("");
  document.getElementById("results-list").innerHTML =
    results.map(r =>
      "<li>" + r.round + ". " + r.word + " – " + (r.correct ? "✅" : "❌") + "</li>"
    ).join("");
  showScreen("screen-result");
});

socket.on("error", (msg) => alert("Fehler: " + msg));

socket.on("playerDisconnected", ({ name }) => {
  console.log(name + " hat die Verbindung verloren.");
});