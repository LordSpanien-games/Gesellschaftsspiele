const socket = io('/cyrano');

const EMOTES = ['🦊','🐻','🐼','🦁','🐯','🐸','🦝','🐺','🦄','🐙'];

let myCode = null;
let myId = null;
let isHost = false;
let selectedEmote = null;
let hasVoted = false;

// SCREENS
const screens = {
  lobby:              document.getElementById('screen-lobby'),
  waiting:            document.getElementById('screen-waiting'),
  waitingTheme:       document.getElementById('screen-waiting-theme'),
  waitingThemeSecret: document.getElementById('screen-waiting-theme-secret'),
  waitingTerm:        document.getElementById('screen-waiting-term'),
  waitingTermAll:     document.getElementById('screen-waiting-term-all'),
  writing:            document.getElementById('screen-writing'),
  voting:             document.getElementById('screen-voting'),
  tower:              document.getElementById('screen-tower'),
  end:                document.getElementById('screen-end')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

function showError(id, msg) {
  document.getElementById(id).textContent = msg;
}

// EMOTE PICKER
function buildEmotePicker(disabledEmotes = []) {
  const container = document.getElementById('emote-options');
  container.innerHTML = '';
  EMOTES.forEach(e => {
    const btn = document.createElement('button');
    btn.classList.add('emote-btn');
    btn.textContent = e;
    if (disabledEmotes.includes(e)) btn.disabled = true;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.emote-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedEmote = e;
    });
    container.appendChild(btn);
  });
}

buildEmotePicker();

// LOBBY
document.getElementById('btn-create').addEventListener('click', () => {
  const name      = document.getElementById('input-name').value.trim();
  const floors    = parseInt(document.getElementById('input-floors').value) || 4;
  const termMode  = document.getElementById('input-termmode').value;
  const themeMode = document.getElementById('input-thememode').value;
  const voting    = document.getElementById('input-voting').value;
  const debug     = document.getElementById('input-debug').checked;
  if (!name)          return showError('lobby-error', 'Name eingeben!');
  if (!selectedEmote) return showError('lobby-error', 'Emote wählen!');
  socket.emit('createRoom', { name, emote: selectedEmote, floors, termMode, themeMode, voting, debug });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!name)          return showError('lobby-error', 'Name eingeben!');
  if (!selectedEmote) return showError('lobby-error', 'Emote wählen!');
  if (!code)          return showError('lobby-error', 'Code eingeben!');
  socket.emit('joinRoom', { name, emote: selectedEmote, code });
});

// WARTERAUM
document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('startGame', { code: myCode });
});

document.getElementById('btn-end-game').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden?')) socket.emit('endGame', { code: myCode });
});

// THEMA REIHUM
document.getElementById('btn-submit-theme').addEventListener('click', () => {
  const theme = document.getElementById('input-theme').value.trim();
  if (!theme) return alert('Thema eingeben!');
  socket.emit('submitTheme', { code: myCode, theme });
  document.getElementById('btn-submit-theme').disabled = true;
  document.getElementById('input-theme').disabled = true;
});

// THEMA SECRET
document.getElementById('btn-submit-theme-secret').addEventListener('click', () => {
  const theme = document.getElementById('input-theme-secret').value.trim();
  if (!theme) return alert('Thema eingeben!');
  socket.emit('submitThemeSecret', { code: myCode, theme });
  document.getElementById('btn-submit-theme-secret').disabled = true;
  document.getElementById('input-theme-secret').disabled = true;
  document.getElementById('theme-secret-status').textContent = '✅ Eingereicht – warte auf andere...';
});

// BEGRIFF REIHUM
document.getElementById('btn-submit-term').addEventListener('click', () => {
  const term = document.getElementById('input-term').value.trim();
  if (!term) return alert('Begriff eingeben!');
  socket.emit('submitTerm', { code: myCode, term });
  document.getElementById('btn-submit-term').disabled = true;
  document.getElementById('input-term').disabled = true;
});

// BEGRIFF ALLE GLEICHZEITIG
document.getElementById('btn-submit-term-all').addEventListener('click', () => {
  const term = document.getElementById('input-term-all').value.trim();
  if (!term) return alert('Begriff eingeben!');
  socket.emit('submitTermAll', { code: myCode, term });
  document.getElementById('btn-submit-term-all').disabled = true;
  document.getElementById('input-term-all').disabled = true;
  document.getElementById('term-all-status').textContent = '✅ Eingereicht – warte auf andere...';
});

// SCHREIBPHASE
document.getElementById('btn-submit-poem').addEventListener('click', () => {
  const text = document.getElementById('poem-text').value.trim();
  if (!text) return alert('Strophe darf nicht leer sein!');
  socket.emit('submitPoem', { code: myCode, text });
  document.getElementById('btn-submit-poem').disabled = true;
});

document.getElementById('btn-end-writing').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden?')) socket.emit('endGame', { code: myCode });
});

// ABSTIMMUNG
document.getElementById('btn-abstain').addEventListener('click', () => {
  if (hasVoted) return;
  socket.emit('abstain', { code: myCode });
  hasVoted = true;
  document.querySelectorAll('#voting-poems button').forEach(b => b.disabled = true);
  document.getElementById('btn-abstain').disabled = true;
  document.getElementById('voting-status').textContent = '🤐 Du hast dich enthalten.';
});

document.getElementById('btn-end-voting').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden?')) socket.emit('endGame', { code: myCode });
});

// TURM
document.getElementById('btn-next-round').addEventListener('click', () => {
  socket.emit('nextRound', { code: myCode });
  document.getElementById('btn-next-round').classList.add('hidden');
  document.getElementById('btn-end-tower').classList.add('hidden');
});

document.getElementById('btn-end-tower').addEventListener('click', () => {
  if (confirm('Spiel wirklich beenden?')) socket.emit('endGame', { code: myCode });
});

// SOCKET EVENTS
socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', ({ code, game }) => {
  myCode = code;
  isHost = true;
  document.getElementById('room-code').textContent = code;
  document.getElementById('btn-start').classList.remove('hidden');
  document.getElementById('btn-end-game').classList.remove('hidden');
  document.getElementById('waiting-msg').classList.add('hidden');
  if (game.config.debug) document.getElementById('debug-badge').classList.remove('hidden');
  updatePlayerList(game.players);
  showScreen('waiting');
});

socket.on('joinedRoom', ({ code, game }) => {
  myCode = code;
  document.getElementById('room-code').textContent = code;
  if (game.config.debug) document.getElementById('debug-badge').classList.remove('hidden');
  updatePlayerList(game.players);
  showScreen('waiting');
});

socket.on('playerJoined', ({ game }) => {
  updatePlayerList(game.players);
});

socket.on('playerLeft', ({ game }) => {
  updatePlayerList(game.players);
});

socket.on('phaseChanged', ({ phase, round, players, termGiver, themeGiver }) => {

  // THEMA REIHUM
  if (phase === 'waiting_theme') {
    document.getElementById('input-theme').value = '';
    document.getElementById('input-theme').disabled = false;
    document.getElementById('btn-submit-theme').disabled = false;
    if (socket.id === themeGiver) {
      document.getElementById('theme-giver-label').textContent = '🎨 Du gibst das Thema für diese Session vor!';
      document.getElementById('input-theme').classList.remove('hidden');
      document.getElementById('btn-submit-theme').classList.remove('hidden');
      document.getElementById('theme-waiting-msg').classList.add('hidden');
    } else {
      const giver = players[themeGiver];
      document.getElementById('theme-giver-label').textContent =
        giver ? `${giver.emote} ${giver.name} gibt das Thema vor...` : 'Warte auf Thema...';
      document.getElementById('input-theme').classList.add('hidden');
      document.getElementById('btn-submit-theme').classList.add('hidden');
      document.getElementById('theme-waiting-msg').classList.remove('hidden');
    }
    showScreen('waitingTheme');
  }

  // THEMA SECRET
  if (phase === 'waiting_theme_secret') {
    document.getElementById('input-theme-secret').value = '';
    document.getElementById('input-theme-secret').disabled = false;
    document.getElementById('btn-submit-theme-secret').disabled = false;
    document.getElementById('theme-secret-status').textContent = '';
    showScreen('waitingThemeSecret');
  }

  // BEGRIFF REIHUM
  if (phase === 'waiting_term') {
    document.getElementById('input-term').value = '';
    document.getElementById('input-term').disabled = false;
    document.getElementById('btn-submit-term').disabled = false;
    if (socket.id === termGiver) {
      document.getElementById('term-giver-label').textContent = '🏷️ Du gibst den Begriff vor!';
      document.getElementById('input-term').classList.remove('hidden');
      document.getElementById('btn-submit-term').classList.remove('hidden');
      document.getElementById('term-waiting-msg').classList.add('hidden');
    } else {
      const giver = players[termGiver];
      document.getElementById('term-giver-label').textContent =
        giver ? `${giver.emote} ${giver.name} gibt den Begriff vor...` : 'Warte auf Begriff...';
      document.getElementById('input-term').classList.add('hidden');
      document.getElementById('btn-submit-term').classList.add('hidden');
      document.getElementById('term-waiting-msg').classList.remove('hidden');
    }
    showScreen('waitingTerm');
  }

  // BEGRIFF ALLE GLEICHZEITIG
  if (phase === 'waiting_term_all') {
    document.getElementById('input-term-all').value = '';
    document.getElementById('input-term-all').disabled = false;
    document.getElementById('btn-submit-term-all').disabled = false;
    document.getElementById('term-all-status').textContent = '';
    showScreen('waitingTermAll');
  }

  // SCHREIBEN
  if (phase === 'writing') {
    hasVoted = false;
    document.getElementById('writing-theme').textContent = round.theme || '–';
    document.getElementById('writing-term').textContent = round.term || '–';
    const giver = players[round.termGiver];
    document.getElementById('term-giver-info').textContent =
      round.termGiver && giver ? `Begriff von: ${giver.emote} ${giver.name}` : '';
    document.getElementById('poem-text').value = '';
    document.getElementById('btn-submit-poem').disabled = false;
    document.getElementById('writing-status').textContent = '';
    if (isHost) document.getElementById('btn-end-writing').classList.remove('hidden');
    showScreen('writing');
  }

  // ABSTIMMUNG
  if (phase === 'voting') {
    hasVoted = false;
    document.getElementById('btn-abstain').disabled = false;
    document.getElementById('voting-status').textContent = '';
    const div = document.getElementById('voting-poems');
    div.innerHTML = '';
    for (const [pid, poem] of Object.entries(round.poems)) {
      const isOwn = pid === myId;
      div.innerHTML += `
        <div class="poem-card">
          <p>${poem.text.replace(/\n/g, '<br>')}</p>
          <button onclick="castVote('${pid}')" ${isOwn ? 'disabled' : ''}>
            ${isOwn ? '(Deine Strophe)' : '👍 Wählen'}
          </button>
        </div>`;
    }
    if (isHost) document.getElementById('btn-end-voting').classList.remove('hidden');
    showScreen('voting');
  }
});

socket.on('themeSubmitted', ({ submitted, total }) => {
  document.getElementById('theme-secret-status').textContent =
    `✅ ${submitted} / ${total} abgegeben – warte auf andere...`;
});

socket.on('termSubmitted', ({ submitted, total }) => {
  document.getElementById('term-all-status').textContent =
    `✅ ${submitted} / ${total} abgegeben – warte auf andere...`;
});

socket.on('poemSubmitted', ({ ready, total }) => {
  document.getElementById('writing-status').textContent = `${ready} / ${total} eingereicht`;
});

socket.on('voteUpdate', ({ round }) => {
  const cards = document.querySelectorAll('.poem-card');
  const poems = Object.values(round.poems);
  cards.forEach((card, i) => {
    if (poems[i]) {
      const btn = card.querySelector('button');
      if (btn && !btn.disabled) btn.textContent = `👍 Wählen (${poems[i].likes})`;
    }
  });
});

socket.on('towerUpdate', ({ players, config, round }) => {
  renderTowerIn('tower-display', players, config.floors);

  const resultDiv = document.getElementById('tower-round-result');
  resultDiv.innerHTML = '<h3>Runde abgeschlossen</h3>';

  if (round) {
    let maxLikes = 0;
    let roundWinner = null;
    for (const [pid, poem] of Object.entries(round.poems)) {
      if (poem.likes > maxLikes) { maxLikes = poem.likes; roundWinner = pid; }
    }
    if (roundWinner && players[roundWinner]) {
      const w = players[roundWinner];
      resultDiv.innerHTML += `<p>🏆 ${w.emote} ${w.name} steigt auf! (${maxLikes} Stimme/n)</p>`;
    } else {
      resultDiv.innerHTML += `<p>Niemand steigt auf diese Runde.</p>`;
    }
    resultDiv.innerHTML += '<hr><h4>Alle Strophen:</h4>';
    for (const [pid, poem] of Object.entries(round.poems)) {
      const p = players[pid];
      resultDiv.innerHTML += `
        <div class="poem-card">
          ${p ? `<strong>${p.emote} ${p.name}</strong>` : ''}
          <p>${poem.text.replace(/\n/g, '<br>')}</p>
          <p>👍 ${poem.likes} Stimme/n</p>
        </div>`;
    }
  }

  if (isHost) {
    document.getElementById('btn-next-round').classList.remove('hidden');
    document.getElementById('btn-end-tower').classList.remove('hidden');
  }
  showScreen('tower');
});

socket.on('gameOver', ({ winner, players, reason }) => {
  const reasons = {
    tower:  '🏰 Turmspitze erreicht!',
    rounds: '📜 Alle Runden gespielt!',
    host:   '🛑 Spiel vorzeitig beendet'
  };
  document.getElementById('end-reason').textContent = reasons[reason] || '';
  document.getElementById('end-winner').textContent = `Gewinner: ${winner.emote} ${winner.name}`;
  const maxFloor = Object.values(players).reduce((m, p) => Math.max(m, p.floor), 4);
  renderTowerIn('tower-display-end', players, maxFloor);
  const div = document.getElementById('end-scores');
  div.innerHTML = '<h3>Rangliste</h3>' + Object.values(players)
    .sort((a, b) => b.floor - a.floor || b.totalLikes - a.totalLikes)
    .map((p, i) => `<p>${i + 1}. ${p.emote} ${p.name} – Etage ${p.floor} | Likes: ${p.totalLikes}</p>`)
    .join('');
  showScreen('end');
});

socket.on('error', ({ msg }) => alert(`Fehler: ${msg}`));

// HELPERS
function castVote(pid) {
  if (hasVoted) return alert('Du hast bereits abgestimmt!');
  socket.emit('vote', { code: myCode, forPlayerId: pid });
  hasVoted = true;
  document.querySelectorAll('#voting-poems button').forEach(b => b.disabled = true);
  document.getElementById('btn-abstain').disabled = true;
  document.getElementById('voting-status').textContent = '✅ Stimme abgegeben!';
}

function updatePlayerList(players) {
  const ul = document.getElementById('player-list');
  ul.innerHTML = Object.values(players)
    .map(p => `<li>${p.emote} ${p.name} ${p.isHost ? '👑' : ''}</li>`)
    .join('');
}

function renderTowerIn(elementId, players, floors) {
  const div = document.getElementById(elementId);
  if (!div) return;
  const maxFloor = floors > 0 ? floors : Math.max(4, ...Object.values(players).map(p => p.floor + 1));
  let output = '';
  for (let f = maxFloor; f >= 0; f--) {
    const here = Object.values(players).filter(p => p.floor === f).map(p => p.emote).join(' ');
    const label = f === maxFloor ? '🏰 Spitze' : `Etage ${f}  `;
    output += `${label} | ${here || '·'}\n`;
  }
  div.textContent = output;
}