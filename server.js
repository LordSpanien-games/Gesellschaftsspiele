const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const erzaehlRouter      = require('./games/erzaehl/router');
const cyranoRouter       = require('./games/cyrano/router');
const soAberAndersRouter = require('./games/so-aber-anders/router');
const dasEineWortRouter  = require('./games/das-eine-wort/router');

app.use('/erzaehl',        erzaehlRouter);
app.use('/cyrano',         cyranoRouter);
app.use('/so-aber-anders', soAberAndersRouter);
app.use('/das-eine-wort',  dasEineWortRouter);

const erzaehlIO      = io.of('/erzaehl');
const cyranoIO       = io.of('/cyrano');
const soAberAndersIO = io.of('/so-aber-anders');
const dasEineWortIO  = io.of('/das-eine-wort');

require('./games/erzaehl/socket')(erzaehlIO);
require('./games/cyrano/socket')(cyranoIO);
require('./games/so-aber-anders/socket')(soAberAndersIO);
require('./games/das-eine-wort/socket')(dasEineWortIO);

server.listen(3000, () => {
  console.log('Gesellschaftsspiele Launcher laeuft auf Port 3000');
});
