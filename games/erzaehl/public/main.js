const socket = io("/erzaehl");
let myPlayerId = null;
let myRoomId = null;
let isHost = false;
let mySentences = [];
let currentIndex = 0;
let currentRoom = null;
let pendingRequest = null;
let callOutCooldown = false;
let gameMode = 'sentences';
let pendingRejoinId = null;
let pendingRejoinRoomId = null;

function showTab(tab, btn) {
  document.getElementById('createTab').style.display = tab === 'create' ? 'block' : 'none';
  document.getElementById('joinTab').style.display = tab === 'join' ? 'block' : 'none';
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  if (el) el.textContent = msg;
}

function showActionMsg(msg, type) {
  const el = document.getElementById('actionMsg');
  if (!el) return;
  el.textContent = msg;
  el.className = 'actionMsg ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'actionMsg'; }, 4000);
}

function showLobby() {
  document.getElementById('startArea').style.display = 'none';
  document.getElementById('lobbyArea').style.display = 'block';
  document.getElementById('gameArea').style.display = 'none';
  document.getElementById('sessionEndArea').style.display = 'none';
  document.getElementById('displayRoomId').textContent = myRoomId;
  if (isHost) {
    document.getElementById('startBtn').style.display = 'block';
    document.getElementById('endSessionBtnLobby').style.display = 'block';
    document.getElementById('waitMsg').style.display = 'none';
  } else {
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('endSessionBtnLobby').style.display = 'none';
    document.getElementById('waitMsg').style.display = 'block';
  }
}

function showGame() {
  document.getElementById('startArea').style.display = 'none';
  document.getElementById('lobbyArea').style.display = 'none';
  document.getElementById('gameArea').style.display = 'grid';
  document.getElementById('sessionEndArea').style.display = 'none';
  if (!isHost) document.getElementById('endSessionBtn').style.display = 'none';
}

function showSessionEnd() {
  document.getElementById('startArea').style.display = 'none';
  document.getElementById('lobbyArea').style.display = 'none';
  document.getElementById('gameArea').style.display = 'none';
  document.getElementById('sessionEndArea').style.display = 'block';
  if (currentRoom) {
    const container = document.getElementById('finalScoreboard');
    container.innerHTML = '';
    const sorted = Object.values(currentRoom.players).sort((a, b) => b.points - a.points);
    sorted.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'scoreItem';
      const medal = i === 0 ? '1.' : i === 1 ? '2.' : i === 2 ? '3.' : '';
      div.innerHTML = '<span>' + medal + ' ' + p.name + '</span><span>' + p.points + ' Punkte</span>';
      container.appendChild(div);
    });
  }
}

function updateModeLabels() {
  const isWords = gameMode === 'words';
  const itemTitle = document.getElementById('currentItemTitle');
  const claimHint = document.getElementById('claimHint');
  const callOutHint = document.getElementById('callOutHint');
  const modeDisplay = document.getElementById('displayMode');
  if (itemTitle) itemTitle.textContent = isWords ? 'Dein aktuelles Wort' : 'Dein aktueller Satz';
  if (claimHint) claimHint.textContent = isWords ? 'Bei wem hast du das Wort verwendet?' : 'Bei wem hast du den Satz verwendet?';
  if (callOutHint) callOutHint.textContent = isWords ? 'Spieler auswaehlen dessen Wort du erkannt hast.' : 'Spieler auswaehlen dessen Satz du erkannt hast.';
  if (modeDisplay) modeDisplay.textContent = 'Modus: ' + (isWords ? 'Wortmodus' : 'Satzmodus');
}

function updateLobbyPlayers(room) {
  const container = document.getElementById('lobbyPlayers');
  if (!container) return;
  container.innerHTML = '';
  for (const pid in room.players) {
    const p = room.players[pid];
    const div = document.createElement('div');
    div.className = 'lobbyPlayer';
    div.textContent = p.name + (pid === room.host ? ' Host' : '');
    container.appendChild(div);
  }
}

function renderCurrentSentence() {
  const sentenceBox = document.getElementById('currentSentence');
  const counter = document.getElementById('sentenceCounter');
  const claimArea = document.getElementById('claimArea');
  const allDone = document.getElementById('allDone');
  if (!sentenceBox) return;
  if (mySentences.length === 0) { sentenceBox.textContent = 'Warte...'; return; }
  if (currentIndex >= mySentences.length) {
    sentenceBox.textContent = '';
    counter.textContent = '';
    claimArea.style.display = 'none';
    allDone.style.display = 'block';
    return;
  }
  sentenceBox.textContent = mySentences[currentIndex].text;
  const label = gameMode === 'words' ? 'Wort' : 'Satz';
  counter.textContent = label + ' ' + (currentIndex + 1) + ' von ' + mySentences.length;
  claimArea.style.display = 'block';
  allDone.style.display = 'none';
}

function updateConfirmTargetSelect() {
  const select = document.getElementById('confirmTargetSelect');
  if (!select) return;
  select.innerHTML = '<option value="">-- Spieler waehlen --</option>';
  if (!currentRoom) return;
  for (const pid in currentRoom.players) {
    if (pid === myPlayerId) continue;
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = currentRoom.players[pid].name;
    select.appendChild(opt);
  }
}

function updateCallOutSelect() {
  const select = document.getElementById('callOutPlayer');
  if (!select) return;
  select.innerHTML = '<option value="">-- Spieler waehlen --</option>';
  if (!currentRoom) return;
  for (const pid in currentRoom.players) {
    if (pid === myPlayerId) continue;
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = currentRoom.players[pid].name;
    select.appendChild(opt);
  }
}

function updateConfirmSentenceSelect() {
  const select = document.getElementById('confirmSentenceSelect');
  if (!select) return;
  select.innerHTML = '<option value="">-- auswaehlen --</option>';
  mySentences.forEach((s, i) => {
    if (!s.used) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = s.text;
      select.appendChild(opt);
    }
  });
}

function renderScoreboard() {
  const container = document.getElementById('scoreboard');
  if (!container) return;
  container.innerHTML = '';
  if (!currentRoom) return;
  const sorted = Object.values(currentRoom.players).sort((a, b) => b.points - a.points);
  sorted.forEach(p => {
    const div = document.createElement('div');
    div.className = 'scoreItem';
    div.innerHTML = '<span>' + p.name + '</span><span>' + p.points + ' Pkt</span>';
    container.appendChild(div);
  });
}

function renderTrophies(trophies) {
  const container = document.getElementById('trophyBoard');
  if (!container) return;
  container.innerHTML = '';
  if (trophies.length === 0) {
    container.innerHTML = '<p class="hint">Noch keine Entdeckungen</p>';
    return;
  }
  trophies.slice().reverse().forEach(t => {
    const div = document.createElement('div');
    div.className = 'trophyItem';
    const time = new Date(t.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = '<div class="trophyWho">' + t.discoveredBy + ' entdeckte ' + t.player + '</div><div class="trophySentence">' + t.sentence + '</div><div style="color:#555;font-size:0.75rem">' + time + '</div>';
    container.appendChild(div);
  });
}
function createRoom() {
  const playerName = document.getElementById('playerName').value.trim();
  if (!playerName) return showError('Bitte Namen eingeben');
  const maxPlayers = parseInt(document.getElementById('maxPlayers').value);
  const sentencesPerPlayer = parseInt(document.getElementById('sentencesPerPlayer').value);
  const penalty = document.getElementById('penalty').value;
  const customId = document.getElementById('customId').value.trim();
  gameMode = document.getElementById('gameMode').value;
  socket.emit('createRoom', { playerName, maxPlayers, sentencesPerPlayer, penalty, customId, gameMode });
}

function joinRoom() {
  const playerName = document.getElementById('playerName').value.trim();
  const roomId = document.getElementById('joinRoomId').value.trim();
  if (!playerName) return showError('Bitte Namen eingeben');
  if (!roomId) return showError('Bitte Raum-ID eingeben');
  socket.emit('joinRoom', { playerName, roomId });
}

function startGame() { socket.emit('startGame'); }
function copyRoomId() { navigator.clipboard.writeText(myRoomId); }
function endSession() {
  if (confirm('Session wirklich beenden?')) socket.emit('endSession');
}

function requestConfirm() {
  const select = document.getElementById('confirmTargetSelect');
  const targetPlayerId = select.value;
  if (!targetPlayerId) return showActionMsg('Bitte Spieler auswaehlen', 'fail');
  if (currentIndex >= mySentences.length) return showActionMsg('Nichts mehr offen', 'fail');
  socket.emit('requestConfirm', { targetPlayerId, sentenceIndex: currentIndex });
  showActionMsg('Warte auf Bestaetigung...', 'success');
}

function callOut() {
  if (callOutCooldown) return showActionMsg('Noch gesperrt!', 'fail');
  const select = document.getElementById('callOutPlayer');
  const targetPlayerId = select.value;
  if (!targetPlayerId) return showActionMsg('Bitte Spieler auswaehlen', 'fail');
  socket.emit('callOut', { targetPlayerId });
  showActionMsg('Warte auf Bestaetigung...', 'success');
}

function confirmAction() {
  if (!pendingRequest) return;
  if (pendingRequest.type === 'used') {
    socket.emit('confirmUsed', { requesterId: pendingRequest.requesterId, sentenceIndex: pendingRequest.sentenceIndex });
  } else {
    const activeSentence = mySentences.findIndex(s => !s.used);
    socket.emit('callOutConfirm', { callerId: pendingRequest.requesterId, sentenceIndex: activeSentence });
  }
  document.getElementById('confirmPopup').style.display = 'none';
  pendingRequest = null;
}

function rejectAction() {
  if (!pendingRequest) return;
  if (pendingRequest.type === 'used') {
    socket.emit('rejectUsed', { requesterId: pendingRequest.requesterId });
  } else {
    socket.emit('callOutReject', { callerId: pendingRequest.requesterId });
  }
  document.getElementById('confirmPopup').style.display = 'none';
  pendingRequest = null;
}

function confirmRejoin() {
  document.getElementById('nameExistsPopup').style.display = 'none';
  myPlayerId = pendingRejoinId;
  myRoomId = pendingRejoinRoomId;
  sessionStorage.setItem('playerId', myPlayerId);
  sessionStorage.setItem('roomId', myRoomId);
  socket.emit('rejoinRoom', { playerId: myPlayerId, roomId: myRoomId });
}

function closeNamePopup() {
  document.getElementById('nameExistsPopup').style.display = 'none';
  pendingRejoinId = null;
  pendingRejoinRoomId = null;
}

socket.on('roomCreated', ({ roomId, playerId }) => {
  myRoomId = roomId; myPlayerId = playerId; isHost = true;
  sessionStorage.setItem('playerId', playerId);
  sessionStorage.setItem('roomId', roomId);
  showLobby();
});

socket.on('roomJoined', ({ roomId, playerId }) => {
  myRoomId = roomId; myPlayerId = playerId; isHost = false;
  sessionStorage.setItem('playerId', playerId);
  sessionStorage.setItem('roomId', roomId);
  showLobby();
});

socket.on('updateRoom', (room) => {
  currentRoom = room;
  gameMode = room.gameMode || 'sentences';
  updateLobbyPlayers(room);
  renderScoreboard();
  updateCallOutSelect();
  updateConfirmTargetSelect();
  updateModeLabels();
});

socket.on('gameStarted', () => { showGame(); });

socket.on('yourSentences', (sentences) => {
  mySentences = sentences;
  currentIndex = 0;
  renderCurrentSentence();
  updateConfirmTargetSelect();
});

socket.on('pointGranted', ({ sentenceIndex, points }) => {
  mySentences[sentenceIndex].used = true;
  currentIndex = sentenceIndex + 1;
  renderCurrentSentence();
  showActionMsg('Punkt erhalten! Gesamt: ' + points, 'success');
});

socket.on('usedRejected', () => { showActionMsg('Bestaetigung abgelehnt!', 'fail'); });

socket.on('confirmRequest', ({ requesterId, requesterName, sentence, sentenceIndex, type }) => {
  pendingRequest = { requesterId, sentenceIndex, type };
  const popupSentence = document.getElementById('popupSentence');
  const calloutArea = document.getElementById('calloutSentenceArea');
  const label = gameMode === 'words' ? 'Wort' : 'Satz';
  if (type === 'used') {
    document.getElementById('popupTitle').textContent = 'Bestaetigung erbeten!';
    document.getElementById('popupText').textContent = requesterName + ' hat diesen ' + label + ' verwendet:';
    popupSentence.textContent = sentence;
    popupSentence.style.display = 'block';
    calloutArea.style.display = 'none';
  } else {
    document.getElementById('popupTitle').textContent = 'Aufdeckversuch!';
    document.getElementById('popupText').textContent = requesterName + ' glaubt deinen ' + label + ' erkannt zu haben!';
    popupSentence.style.display = 'none';
    calloutArea.style.display = 'none';
  }
  document.getElementById('confirmPopup').style.display = 'flex';
});

socket.on('callOutSuccess', ({ points }) => {
  showActionMsg('Aufgedeckt! Punkt erhalten! Gesamt: ' + points, 'success');
});

socket.on('callOutFailed', ({ penalty }) => {
  let msg = 'Falsch geraten!';
  if (penalty === 'minus') msg += ' -1 Punkt';
  if (penalty === 'cooldown') {
    msg += ' 30 Sek. Sperre';
    callOutCooldown = true;
    setTimeout(() => { callOutCooldown = false; }, 30000);
  }
  showActionMsg(msg, 'fail');
});

socket.on('nameExists', ({ existingPlayerId, roomId }) => {
  pendingRejoinId = existingPlayerId;
  pendingRejoinRoomId = roomId;
  document.getElementById('nameExistsPopup').style.display = 'flex';
});

socket.on('rejoinConfirm', ({ isHost: hostStatus, roomId, playerId, started }) => {
  myPlayerId = playerId;
  myRoomId = roomId;
  isHost = hostStatus;
  sessionStorage.setItem('playerId', playerId);
  sessionStorage.setItem('roomId', roomId);
  if (started) { showGame(); } else { showLobby(); }
});

socket.on('trophyUpdate', (trophies) => { renderTrophies(trophies); });
socket.on('sessionEnded', () => { showSessionEnd(); });
socket.on('error', (msg) => { showActionMsg(msg, 'fail'); showError(msg); });