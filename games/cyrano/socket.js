const games = {};



const EMOTES = ['\u{1F98A}','\u{1F43B}','\u{1F43C}','\u{1F981}','\u{1F42F}','\u{1F438}','\u{1F99D}','\u{1F43A}','\u{1F984}','\u{1F419}'];

const AUTO_THEMES = ['Mondlicht','Sommerabend','Vergessen','Regen','Sehnsucht','Feuer','Zeit','Stille','Traum','Meer'];

const AUTO_TERMS  = ['Liebe','Held','Schatten','Stern','Fluss','Berg','Wind','Herz','Nacht','Licht'];



function generateCode() {

  return Math.random().toString(36).substring(2, 8).toUpperCase();

}



function getGame(socket, code) {

  const game = games[code];

  if (!game) { socket.emit('error', { msg: 'Raum nicht gefunden' }); return null; }

  return game;

}



function checkWinner(game) {

  if (game.config.floors === 0) return null;

  return Object.values(game.players).find(p => p.floor >= game.config.floors);

}



function getLeader(game) {

  return Object.values(game.players).sort((a, b) => {

    if (b.floor !== a.floor) return b.floor - a.floor;

    return b.totalLikes - a.totalLikes;

  })[0];

}



function resolveRound(cyrano, game, code) {

  const voting = game.config.voting;

  const round = game.rounds[game.currentRound];



  if (voting === 'no_all') {

    for (const pid of Object.keys(game.players)) game.players[pid].floor++;

  } else if (voting === 'yes') {

    let maxLikes = 0;

    let winner = null;

    for (const [pid, poem] of Object.entries(round.poems)) {

      if (poem.likes > maxLikes) { maxLikes = poem.likes; winner = pid; }

    }

    if (winner) game.players[winner].floor++;

  }



  cyrano.to(code).emit('towerUpdate', { players: game.players, config: game.config, round });



  const gameWinner = checkWinner(game);

  if (gameWinner) {

    game.phase = 'tower';

    cyrano.to(code).emit('gameOver', { winner: gameWinner, players: game.players, reason: 'tower' });

    return;

  }



  if (game.config.floors > 0 && game.currentRound + 1 >= game.config.floors) {

    game.phase = 'tower';

    const leader = getLeader(game);

    cyrano.to(code).emit('gameOver', { winner: leader, players: game.players, reason: 'rounds' });

    return;

  }



  game.phase = 'tower';

  game.currentRound++;

  game.termGiverIndex = (game.termGiverIndex + 1) % Object.keys(game.players).length;

}



function startNewRound(cyrano, game, code) {

  const playerIds = Object.keys(game.players);

  const termGiver = playerIds[game.termGiverIndex % playerIds.length];



  let term = null;

  if (game.config.termMode === 'system') {

    term = AUTO_TERMS[Math.floor(Math.random() * AUTO_TERMS.length)];

  }



  game.rounds.push({

    index: game.currentRound,

    term,

    theme: game.theme,

    termGiver,

    termSubmissions: {},

    poems: {},

    ready: [],

    abstentions: []

  });



  if (game.config.termMode === 'reihum') {

    game.phase = 'waiting_term';

    cyrano.to(code).emit('phaseChanged', { phase: 'waiting_term', termGiver, players: game.players });

  } else if (game.config.termMode === 'all') {

    game.phase = 'waiting_term_all';

    cyrano.to(code).emit('phaseChanged', { phase: 'waiting_term_all', players: game.players });

  } else {

    game.phase = 'writing';

    cyrano.to(code).emit('phaseChanged', {

      phase: 'writing',

      round: game.rounds[game.currentRound],

      players: game.players

    });

  }

}



function initThemeAndStart(cyrano, game, code) {

  if (game.config.themeMode === 'auto') {

    game.theme = AUTO_THEMES[Math.floor(Math.random() * AUTO_THEMES.length)];

    startNewRound(cyrano, game, code);

  } else if (game.config.themeMode === 'reihum') {

    game.phase = 'waiting_theme';

    const playerIds = Object.keys(game.players);

    game.themeGiver = playerIds[0];

    cyrano.to(code).emit('phaseChanged', { phase: 'waiting_theme', themeGiver: game.themeGiver, players: game.players });

  } else if (game.config.themeMode === 'secret') {

    game.phase = 'waiting_theme_secret';

    game.themeSubmissions = {};

    cyrano.to(code).emit('phaseChanged', { phase: 'waiting_theme_secret', players: game.players });

  }

}



module.exports = (cyrano) => {

  cyrano.on('connection', (socket) => {

    console.log(`[Cyrano] Verbunden: ${socket.id}`);



    socket.on('createRoom', ({ name, emote, floors = 4, termMode = 'system', themeMode = 'auto', voting = 'yes', debug = false }) => {

      const code = generateCode();

      games[code] = {

        code, phase: 'lobby',

        config: { floors, termMode, themeMode, voting, debug },

        termGiverIndex: 0,

        theme: null,

        themeSubmissions: {},

        players: {

          [socket.id]: { id: socket.id, name, emote, floor: 0, totalLikes: 0, isHost: true }

        },

        usedEmotes: [emote],

        rounds: [], currentRound: 0

      };

      socket.join(code);

      socket.emit('roomCreated', { code, game: games[code] });

    });



    socket.on('joinRoom', ({ name, emote, code }) => {

      const game = games[code];

      if (!game) return socket.emit('error', { msg: 'Raum nicht gefunden' });

      if (Object.keys(game.players).length >= 9) return socket.emit('error', { msg: 'Raum voll' });

      if (game.phase !== 'lobby') return socket.emit('error', { msg: 'Spiel läuft bereits' });

      if (game.usedEmotes.includes(emote)) return socket.emit('error', { msg: 'Emote bereits vergeben' });

      game.players[socket.id] = { id: socket.id, name, emote, floor: 0, totalLikes: 0, isHost: false };

      game.usedEmotes.push(emote);

      socket.join(code);

      cyrano.to(code).emit('playerJoined', { game });

      socket.emit('joinedRoom', { code, game });

    });



    socket.on('startGame', ({ code }) => {

      const game = getGame(socket, code);

      if (!game) return;

      const minPlayers = game.config.debug ? 1 : 4;

      if (Object.keys(game.players).length < minPlayers) {

        return socket.emit('error', { msg: `Mindestens ${minPlayers} Spieler nötig` });

      }

      initThemeAndStart(cyrano, game, code);

    });



    socket.on('nextRound', ({ code }) => {

      const game = getGame(socket, code);

      if (!game) return;

      if (!game.players[socket.id]?.isHost) return;

      startNewRound(cyrano, game, code);

    });



    socket.on('submitTheme', ({ code, theme }) => {

      const game = getGame(socket, code);

      if (!game || game.phase !== 'waiting_theme') return;

      if (socket.id !== game.themeGiver) return;

      game.theme = theme;

      startNewRound(cyrano, game, code);

    });



    socket.on('submitThemeSecret', ({ code, theme }) => {

      const game = getGame(socket, code);

      if (!game || game.phase !== 'waiting_theme_secret') return;

      game.themeSubmissions[socket.id] = theme;

      const total = Object.keys(game.players).length;

      const submitted = Object.keys(game.themeSubmissions).length;

      cyrano.to(code).emit('themeSubmitted', { submitted, total });

      if (submitted === total) {

        const themes = Object.values(game.themeSubmissions);

        game.theme = themes[Math.floor(Math.random() * themes.length)];

        startNewRound(cyrano, game, code);

      }

    });



    socket.on('submitTerm', ({ code, term }) => {

      const game = getGame(socket, code);

      if (!game || game.phase !== 'waiting_term') return;

      const round = game.rounds[game.currentRound];

      if (socket.id !== round.termGiver) return;

      round.term = term;

      game.phase = 'writing';

      cyrano.to(code).emit('phaseChanged', { phase: 'writing', round, players: game.players });

    });



    socket.on('submitTermAll', ({ code, term }) => {

      const game = getGame(socket, code);

      if (!game || game.phase !== 'waiting_term_all') return;

      const round = game.rounds[game.currentRound];

      round.termSubmissions[socket.id] = term;

      const total = Object.keys(game.players).length;

      const submitted = Object.keys(round.termSubmissions).length;

      cyrano.to(code).emit('termSubmitted', { submitted, total });

      if (submitted === total) {

        const terms = Object.values(round.termSubmissions);

        round.term = terms[Math.floor(Math.random() * terms.length)];

        game.phase = 'writing';

        cyrano.to(code).emit('phaseChanged', { phase: 'writing', round, players: game.players });

      }

    });



    socket.on('submitPoem', ({ code, text }) => {

      const game = getGame(socket, code);

      if (!game || game.phase !== 'writing') return;

      const round = game.rounds[game.currentRound];

      round.poems[socket.id] = { text, likes: 0, voters: [] };

      round.ready.push(socket.id);

      cyrano.to(code).emit('poemSubmitted', {

        ready: round.ready.length,

        total: Object.keys(game.players).length

      });

      if (round.ready.length === Object.keys(game.players).length) {

        if (game.config.voting === 'yes') {

          game.phase = 'voting';

          cyrano.to(code).emit('phaseChanged', { phase: 'voting', round, players: game.players });

        } else {

          resolveRound(cyrano, game, code);

        }

      }

    });



    socket.on('vote', ({ code, forPlayerId }) => {

      const game = getGame(socket, code);

      if (!game || game.phase !== 'voting') return;

      const round = game.rounds[game.currentRound];

      if (forPlayerId === socket.id) return socket.emit('error', { msg: 'Nicht für sich selbst stimmen!' });

      if (round.poems[forPlayerId].voters.includes(socket.id)) return;

      if (round.abstentions.includes(socket.id)) return;

      round.poems[forPlayerId].voters.push(socket.id);

      round.poems[forPlayerId].likes++;

      game.players[forPlayerId].totalLikes++;

      cyrano.to(code).emit('voteUpdate', { round });

      checkAllVoted(cyrano, game, code, round);

    });



    socket.on('abstain', ({ code }) => {

      const game = getGame(socket, code);

      if (!game || game.phase !== 'voting') return;

      const round = game.rounds[game.currentRound];

      if (round.abstentions.includes(socket.id)) return;

      if (Object.values(round.poems).some(p => p.voters.includes(socket.id))) return;

      round.abstentions.push(socket.id);

      cyrano.to(code).emit('voteUpdate', { round });

      checkAllVoted(cyrano, game, code, round);

    });



    socket.on('endGame', ({ code }) => {

      const game = getGame(socket, code);

      if (!game) return;

      if (!game.players[socket.id]?.isHost) return;

      game.phase = 'end';

      const winner = getLeader(game);

      cyrano.to(code).emit('gameOver', { winner, players: game.players, reason: 'host' });

    });



    socket.on('disconnect', () => {

      for (const code in games) {

        if (games[code].players[socket.id]) {

          delete games[code].players[socket.id];

          cyrano.to(code).emit('playerLeft', { game: games[code] });

          if (Object.keys(games[code].players).length === 0) delete games[code];

        }

      }

    });

  });

};



function checkAllVoted(cyrano, game, code, round) {

  const totalPlayers = Object.keys(game.players).length;

  const totalVotes = Object.values(round.poems).reduce((s, p) => s + p.voters.length, 0);

  const totalAbstentions = round.abstentions.length;

  if (totalVotes + totalAbstentions === totalPlayers) {

    resolveRound(cyrano, game, code);

  }

}