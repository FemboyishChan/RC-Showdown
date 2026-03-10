const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs');
const util = require('util');

const http = require('http');

// This script provides a very small "login server" for local testing.
// It serves the client files (play.pokemonshowdown.com) and implements
// the subset of the real action.php API that the client uses.  Right now
// we only care about /action.php?act=register (and login so that the
// user can immediately use their newly-created account).
//
// You can start this with `npm run start-login-server` (see
// package.json), and then visit http://localhost:3000/testclient.html in
// your browser.  The register button will create a simple sqlite database
// (`users.db` in the same directory) storing the account information.

const PORT = 3000;
const app = express();

// parse form-encoded bodies (jQuery sends form data, not JSON)
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

// Allow cross-origin requests so the client can talk to the login server
// from any port (e.g. game server on port 8000, tunnels, etc.)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve news.json from config/news.json (mirrors config/news.inc.php for Node)
app.get('/news.json', (req, res) => {
  const newsFile = path.join(__dirname, 'config', 'news.json');
  if (fs.existsSync(newsFile)) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.json(JSON.parse(fs.readFileSync(newsFile, 'utf8')));
  } else {
    res.json([]);
  }
});

// serve the client source tree so you can just open it from the login
// server host and have the AJAX requests all be same-origin.
// On Windows, git symlinks may be stored as plain text files, so we
// explicitly serve the real config/ and data/ directories first.
// add cache-control headers for data files to force fresh downloads
app.use((req, res, next) => {
  if (req.method === 'POST') console.log(`[REQ] ${req.method} ${req.url}`);
  if (req.url.startsWith('/data/')) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});
app.use('/config', express.static(path.join(__dirname, 'config')));
app.use(express.static(path.join(__dirname, 'play.pokemonshowdown.com')));

// A very small sqlite database for accounts.  The real server uses MySQL
// and has a lot more fields and sanity checks; this is intentionally
// minimal.  Passwords are hashed with scrypt (a memory-hard KDF) for
// strong protection against brute-force and GPU/ASIC attacks.
const dbFile = path.join(__dirname, 'users.db');
const db = new sqlite3.Database(dbFile);

// simple rate-limit tracker: map IP -> array of timestamps (seconds)
const registrations = {};
const loginAttempts = {};

// ---------------------------------------------------------------------------
// Scrypt parameters (memory-hard KDF – resistant to GPU / ASIC brute-force)
// ---------------------------------------------------------------------------
const SCRYPT_N = 32768;    // CPU / memory cost  (2^15)
const SCRYPT_R = 8;        // block size
const SCRYPT_P = 1;        // parallelism
const SCRYPT_KEYLEN = 64;  // derived-key length in bytes
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MiB – raise OpenSSL default
const scryptAsync = util.promisify(crypto.scrypt);
const SCRYPT_OPTS = {N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM};

const MAX_LOGIN_ATTEMPTS = 10;   // per IP
const LOGIN_WINDOW_SECS  = 300;  // 5-minute sliding window

// ---------------------------------------------------------------------------
// RSA key pair for signing assertions the game server can verify
// ---------------------------------------------------------------------------
const PRIVATE_KEY = fs.readFileSync(path.join(__dirname, 'config', 'local-private.pem'), 'utf8');
const ASSERTION_HOSTNAME = 'localhost';  // must match game server’s Config.legalhosts

/**
 * Build a signed assertion the PS game server will accept.
 *   Format: challenge,userid,userType,timestamp,hostname;SIGNATURE
 *   userType: '2' = registered, '1' = unregistered guest
 */
function signAssertion(challstr, userid, registered) {
  // challstr from the client is "keyid|challenge" – we only sign the challenge part.
  const pipeIndex = challstr.indexOf('|');
  const challenge = pipeIndex >= 0 ? challstr.slice(pipeIndex + 1, pipeIndex + 1 + 256) : challstr;
  if (challenge.length !== 256 || !/^[0-9a-f]+$/.test(challenge)) {
    console.log(`[SIGN] WARNING: bad challenge (length=${challenge.length}). Full challstr: '${challstr.substring(0, 300)}'`);
  }
  const userType = registered ? '2' : '1';
  const timestamp = Math.floor(Date.now() / 1000);
  const tokenData = [challenge, userid, userType, timestamp, ASSERTION_HOSTNAME].join(',');
  const signer = crypto.createSign('RSA-SHA1');
  signer.update(tokenData);
  const signature = signer.sign(PRIVATE_KEY, 'hex');
  return tokenData + ';' + signature;
}

/**
 * Hash a plaintext password with scrypt and a fresh 32-byte random salt.
 * Returns {salt, hash} where hash is prefixed with "scrypt$".
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return {salt, hash: 'scrypt$' + derived.toString('hex')};
}

/**
 * Verify a password against a stored hash + salt.
 * Supports three storage formats (newest → oldest):
 *   1. scrypt$<hex>        – current best
 *   2. PBKDF2-SHA512 hex   – legacy (has a salt, but no prefix)
 *   3. Plain SHA-256 hex   – ancient (no salt)
 * Uses crypto.timingSafeEqual to prevent timing side-channels.
 */
async function verifyPassword(password, storedHash, salt) {
  if (storedHash.startsWith('scrypt$')) {
    const expected = Buffer.from(storedHash.slice(7), 'hex');
    const derived  = await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } else if (salt) {
    const derived  = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
    const expected = Buffer.from(storedHash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } else {
    const hash     = crypto.createHash('sha256').update(password).digest();
    const expected = Buffer.from(storedHash, 'hex');
    if (hash.length !== expected.length) return false;
    return crypto.timingSafeEqual(hash, expected);
  }
}

// ensure the users table has columns for a salt and register time
// (the ALTER TABLE is safe to run repeatedly in sqlite)
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      userid TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      passwordhash TEXT,
      salt TEXT,
      registertime INTEGER
    )`
  );
  db.get("PRAGMA table_info(users)", (err, row) => {
    if (err) return;
    // if the schema was created before salt column existed, add it
    db.all("PRAGMA table_info(users)", (err2, cols) => {
      if (!err2 && cols && !cols.some(c => c.name === 'salt')) {
        db.run("ALTER TABLE users ADD COLUMN salt TEXT");
      }
    });
  });
});

function toID(name) {
  return ('' + name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The PS client expects JSON responses prefixed with ']' (anti-XSSI guard).
// It strips the prefix in Storage.safeJSON before JSON.parse.
function sendJSON(res, obj) {
  res.type('text').send(']' + JSON.stringify(obj));
}

// Handle both /action.php and /~~<serverid>/action.php (the client prefixes
// its requests with /~~showdown/ when talking through the game server route).
app.post(['/action.php', /^\/~~[^/]+\/action\.php$/], (req, res) => {
  const act = (req.body.act || '').toString();
  console.log(`[LOGIN] ${req.method} ${req.url} act=${act} body=${JSON.stringify(req.body).slice(0,200)}`);

  if (act === 'register') {
    const username = (req.body.username || '').toString().trim();
    const password = (req.body.password || '').toString();
    const cpassword = (req.body.cpassword || '').toString();

    if (!username) return sendJSON(res, {actionerror: 'Username is required'});
    if (username.length > 32) return sendJSON(res, {actionerror: 'Username must be 32 characters or fewer'});
    if (!/^[A-Za-z0-9]/.test(username)) return sendJSON(res, {actionerror: 'Username must start with a letter or number'});
    if (/[^A-Za-z0-9 _-]/.test(username)) return sendJSON(res, {actionerror: 'Username may only contain letters, numbers, spaces, hyphens, and underscores'});
    const userid = toID(username);
    if (!userid) return sendJSON(res, {actionerror: 'Username must contain at least one letter or number'});
    if (!password) return sendJSON(res, {actionerror: 'Password is required'});
    if (password.length < 8) return sendJSON(res, {actionerror: 'Password must be at least 8 characters'});
    if (password.length > 1024) return sendJSON(res, {actionerror: 'Password is too long'});
    if (password !== cpassword) return sendJSON(res, {actionerror: 'Passwords don\'t match'});

    // rate limit registrations per IP
    const ip = req.ip || req.connection.remoteAddress || '';
    const nowts = Math.floor(Date.now() / 1000);
    registrations[ip] = registrations[ip] || [];
    registrations[ip] = registrations[ip].filter(ts => ts > nowts - 60);
    if (registrations[ip].length >= 5) {
      return sendJSON(res, {actionerror: 'Too many registrations from this IP; try again later.'});
    }
    registrations[ip].push(nowts);

    db.get('SELECT userid FROM users WHERE userid = ?', [userid], (err, row) => {
      if (err) return sendJSON(res, {actionerror: 'Database error'});
      if (row) {
        return sendJSON(res, {actionerror: 'Username already taken'});
      }

      // hash with scrypt (memory-hard, resistant to GPU/ASIC attacks)
      const challstr = (req.body.challstr || '').toString();
      hashPassword(password).then(({salt, hash}) => {
        db.run(
          'INSERT INTO users (userid, username, passwordhash, salt, registertime) VALUES (?,?,?,?,?)',
          [userid, username, hash, salt, nowts],
          function (err2) {
            if (err2) return sendJSON(res, {actionerror: 'Database error'});
            const assertion = challstr ? signAssertion(challstr, userid, true) : crypto.randomBytes(32).toString('hex');
            sendJSON(res, {
              curuser: {username, userid, loggedin: 1},
              assertion: assertion,
            });
          }
        );
      }).catch(err => {
        console.error('Registration hash error:', err);
        sendJSON(res, {actionerror: 'Server error during registration'});
      });
    });
  } else if (act === 'getassertion') {
    // The client calls this when a user types a name to check if it's registered.
    // Return ';' if registered (client will prompt for password),
    // or a signed assertion if unregistered (client can log in directly).
    const userid = toID((req.body.userid || '').toString());
    const challstr = (req.body.challstr || '').toString();
    if (!userid) return res.send(';;Your name is invalid.');

    db.get('SELECT userid FROM users WHERE userid = ?', [userid], (err, row) => {
      if (err) return res.send(';;Database error');
      if (row) {
        // registered – tell client to ask for a password
        return res.send(';');
      }
      // unregistered – sign a guest assertion (userType '1')
      if (!challstr) return res.send(';;Missing challstr');
      res.send(signAssertion(challstr, userid, false));
    });

  } else if (act === 'upkeep') {
    // Called on page load to check if the user has an active session.
    // We don't implement persistent sessions yet, so just return empty.
    sendJSON(res, {loggedin: false, username: ''});

  } else if (act === 'login') {
    const username = (req.body.name || req.body.username || '').toString();
    const password = (req.body.pass || req.body.password || '').toString();
    const challstr = (req.body.challstr || '').toString();
    const userid = toID(username);

    console.log(`[LOGIN-DEBUG] Login attempt for '${username}' (userid: '${userid}')`);
    console.log(`[LOGIN-DEBUG] challstr received: length=${challstr.length}, first60='${challstr.substring(0, 60)}'`);
    if (!challstr) console.log(`[LOGIN-DEBUG] WARNING: challstr is empty!`);

    // rate-limit login attempts per IP to slow brute-force
    const loginIp  = req.ip || req.connection.remoteAddress || '';
    const loginNow = Math.floor(Date.now() / 1000);
    if (!loginAttempts[loginIp]) loginAttempts[loginIp] = [];
    loginAttempts[loginIp] = loginAttempts[loginIp].filter(ts => ts > loginNow - LOGIN_WINDOW_SECS);
    if (loginAttempts[loginIp].length >= MAX_LOGIN_ATTEMPTS) {
      return sendJSON(res, {error: 'Too many login attempts; please wait a few minutes.'});
    }
    loginAttempts[loginIp].push(loginNow);

    db.get('SELECT username, passwordhash, salt FROM users WHERE userid = ?', [userid], (err, row) => {
      if (err) return sendJSON(res, {error: 'Database error'});
      if (!row) {
        return sendJSON(res, {error: 'Invalid username/password'});
      }
      verifyPassword(password, row.passwordhash, row.salt).then(ok => {
        if (!ok) {
          return sendJSON(res, {error: 'Invalid username/password'});
        }
        // success – clear this IP's failed-attempt counter
        loginAttempts[loginIp] = [];

        // transparently upgrade legacy hashes (PBKDF2 / SHA-256) to scrypt
        if (!row.passwordhash.startsWith('scrypt$')) {
          hashPassword(password).then(({salt: newSalt, hash: newHash}) => {
            db.run('UPDATE users SET passwordhash = ?, salt = ? WHERE userid = ?',
              [newHash, newSalt, userid]);
          }).catch(() => {}); // non-fatal; will retry next login
        }

        const assertion = challstr ? signAssertion(challstr, userid, true) : crypto.randomBytes(32).toString('hex');
        sendJSON(res, {curuser: {username: row.username, userid, loggedin: 1}, assertion: assertion});
      }).catch(err => {
        console.error('Login verify error:', err);
        sendJSON(res, {error: 'Server error during login'});
      });
    });
  } else if (act === 'uploadreplay') {
    // replay storage: save the log and extract metadata for JSON responses
    const log = (req.body.log || '').toString();
    let id = (req.body.id || '').toString();
    if (!id) {
      id = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 20);
    }
    // sanitize id to alphanumeric + hyphen
    id = id.replace(/[^a-z0-9\-]/gi, '').toLowerCase();
    if (!id) id = (Date.now().toString(36));

    // extract player names and format from the log
    let p1 = '', p2 = '', format = '';
    const lines = log.split('\n');
    for (const line of lines) {
      if (line.startsWith('|player|p1|')) p1 = line.split('|')[3] || '';
      if (line.startsWith('|player|p2|')) p2 = line.split('|')[3] || '';
      if (line.startsWith('|tier|')) format = line.split('|')[2] || '';
    }

    const dir = path.join(__dirname, 'replays');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    // save the raw log
    const filename = path.join(dir, id + '.txt');
    fs.writeFileSync(filename, log);
    // save metadata as JSON alongside
    const meta = { id, p1, p2, format, uploadtime: Math.floor(Date.now() / 1000), log };
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(meta));

    // reply in same format as the real login server
    res.send('success:' + id);
  } else {
    sendJSON(res, {actionerror: 'Unsupported action: ' + act});
  }
});

// serve replay JSON by id (used by in-app replay viewer)
app.get('/replay/:id.json', (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9\-]/gi, '').toLowerCase();
  const jsonFile = path.join(__dirname, 'replays', id + '.json');
  const txtFile = path.join(__dirname, 'replays', id + '.txt');
  if (fs.existsSync(jsonFile)) {
    const meta = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    res.json({
      id: meta.id,
      format: meta.format || '',
      players: [meta.p1 || 'Player 1', meta.p2 || 'Player 2'],
      log: meta.log,
      uploadtime: meta.uploadtime || 0,
    });
  } else if (fs.existsSync(txtFile)) {
    // legacy: only .txt exists, reconstruct metadata from log
    const log = fs.readFileSync(txtFile, 'utf8');
    let p1 = 'Player 1', p2 = 'Player 2', format = '';
    for (const line of log.split('\n')) {
      if (line.startsWith('|player|p1|')) p1 = line.split('|')[3] || p1;
      if (line.startsWith('|player|p2|')) p2 = line.split('|')[3] || p2;
      if (line.startsWith('|tier|')) format = line.split('|')[2] || format;
    }
    res.json({ id, format, players: [p1, p2], log, uploadtime: 0 });
  } else {
    res.status(404).json(null);
  }
});

// serve stored replays by id (HTML page)
app.get('/replay/:id', (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9\-]/gi, '').toLowerCase();
  const txtFile = path.join(__dirname, 'replays', id + '.txt');
  const jsonFile = path.join(__dirname, 'replays', id + '.json');
  let log = '';
  let p1 = 'Player 1', p2 = 'Player 2', format = '';
  if (fs.existsSync(jsonFile)) {
    const meta = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    log = meta.log || '';
    p1 = meta.p1 || p1;
    p2 = meta.p2 || p2;
    format = meta.format || '';
  } else if (fs.existsSync(txtFile)) {
    log = fs.readFileSync(txtFile, 'utf8');
    for (const line of log.split('\n')) {
      if (line.startsWith('|player|p1|')) p1 = line.split('|')[3] || p1;
      if (line.startsWith('|player|p2|')) p2 = line.split('|')[3] || p2;
      if (line.startsWith('|tier|')) format = line.split('|')[2] || format;
    }
  } else {
    res.status(404).send('Replay not found');
    return;
  }
  const title = format ? `${format}: ${p1} vs. ${p2}` : `${p1} vs. ${p2}`;
  const escapedLog = log.replace(/</g, '\\u003c');
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width" />
<title>${title} - Replay</title>
</head><body>
<div class="wrapper replay-wrapper">
<input type="hidden" name="replayid" value="${id}" />
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<script type="text/plain" class="battle-log-data">${escapedLog}</script>
</div>
<script>
let daily = Math.floor(Date.now()/1000/60/60/24);
document.write('<script src="/js/replay-embed.js?version'+daily+'"><\\/script>');
</script>
</body></html>`;
  res.send(html);
});

// ---------------------------------------------------------------------------
// Reverse-proxy to game server (port 8000) so a single origin works
// ---------------------------------------------------------------------------
const GAME_SERVER_HOST = 'localhost';
const GAME_SERVER_PORT = 8000;

// Proxy /showdown/* HTTP requests (SockJS polling/XHR transports)
app.all('/showdown/*', (req, res) => {
  const options = {
    hostname: GAME_SERVER_HOST,
    port: GAME_SERVER_PORT,
    path: req.originalUrl,
    method: req.method,
    headers: Object.assign({}, req.headers, {host: `${GAME_SERVER_HOST}:${GAME_SERVER_PORT}`}),
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, {end: true});
  });
  proxyReq.on('error', (err) => {
    console.error('[PROXY] Game server request error:', err.message);
    if (!res.headersSent) res.status(502).send('Game server unavailable');
  });
  req.pipe(proxyReq, {end: true});
});

// Create HTTP server from the Express app so we can handle 'upgrade' events
const server = http.createServer(app);

// Proxy WebSocket upgrades for /showdown/* to the game server
server.on('upgrade', (req, socket, head) => {
  console.log(`[WS UPGRADE] url=${req.url} origin=${req.headers.origin}`);
  if (!req.url || !req.url.startsWith('/showdown')) {
    console.log(`[WS UPGRADE] rejected non-showdown path: ${req.url}`);
    socket.destroy();
    return;
  }
  const options = {
    hostname: GAME_SERVER_HOST,
    port: GAME_SERVER_PORT,
    path: req.url,
    method: 'GET',
    headers: Object.assign({}, req.headers, {host: `${GAME_SERVER_HOST}:${GAME_SERVER_PORT}`}),
  };
  const proxyReq = http.request(options);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // Send the HTTP 101 back to the client
    let rawHeaders = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      rawHeaders += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    rawHeaders += '\r\n';
    socket.write(rawHeaders);
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    // Bi-directional pipe
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('error', (err) => {
    console.error('[PROXY] WebSocket upgrade error:', err.message);
    socket.destroy();
  });
  proxyReq.end();
});

server.listen(PORT, () => {
  console.log(`Login/static server running on http://localhost:${PORT}`);
  console.log(`Game server proxy: /showdown/* -> ${GAME_SERVER_HOST}:${GAME_SERVER_PORT}`);
});
