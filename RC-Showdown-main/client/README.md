Pokémon Showdown Client
========================================================================

Navigation: [Website][1] | [Server repository][2] | **Client repository** | [Dex repository][3]

  [1]: http://pokemonshowdown.com/
  [2]: https://github.com/Zarel/Pokemon-Showdown
  [3]: https://github.com/Zarel/Pokemon-Showdown-Dex

Introduction
------------------------------------------------------------------------

This is a repository for most of the client code for Pokémon Showdown.

This is what runs `play.pokemonshowdown.com`.

**WARNING: You probably want the [Pokémon Showdown server][4]**, if you're
setting up a server.

  [4]: https://github.com/Zarel/Pokemon-Showdown

Browser support
------------------------------------------------------------------------

Pokémon Showdown currently supports, in order of preference:

 - Chrome
 - Chromium browsers (Edge, Vivaldi, Brave, Opera...)
 - Firefox
 - Safari 5+
 - IE11+ and Edge
 - Chrome/Firefox/Safari for various mobile devices
 - any remotely modern browser

Pokémon Showdown is usable, but expect degraded performance and certain features not to work in extremely legacy browsers like:

 - Safari 4
 - IE9-10

Pokémon Showdown is mostly developed on Chrome, and Chrome or the desktop client is required for certain features like dragging-and-dropping teams from PS to your computer. However, bugs reported on any supported browser will usually be fixed pretty quickly.

New client
------------------------------------------------------------------------

Development is proceeding on the client rewrite! The live version is
available at https://play.pokemonshowdown.com/beta

You can contribute to it yourself using the same process as before, just
use `testclient-beta.html` rather than `testclient.html`.

Testing (the old client)
------------------------------------------------------------------------

Client testing requires a build step! Install the latest Node.js (we
require v20 or later) and Git, and run `node build` (on Windows) or `./build`
(on other OSes) to build.

You can make and test client changes simply by building after each change,
and opening `play.pokemonshowdown.com/testclient.html`. This will allow you
to test changes to the client without setting up your own login server.

### Test keys

For security reasons, browsers [don't let other websites control PS][5], so
they can't screw with your account, but it does make it harder to log in on
the test client.

The default hack makes you copy/paste the data instead, but if you're
refreshing a lot, just add a `config/testclient-key.js` file, with the
contents:

    const POKEMON_SHOWDOWN_TESTCLIENT_KEY = 'sid';

Replace `sid` with the contents of your actual PS `sid` cookie. You can quickly
grab it from:

> https://play.pokemonshowdown.com/testclient-key.php

Make sure to put it in `config/` and not `play.pokemonshowdown.com/config/`.

(This is the only supported method of logging in on the beta testclient.)

  [5]: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS

### Other servers

You can connect to an arbitrary server by navigating to
`testclient.html?~~host:port`. For example, to connect to a server running
locally on port 8000, you can navigate to `testclient.html?~~localhost:8000`.

**NOTE**: Certain browsers will convert `'?'` to `'%3F'` when reading files off
of the local filesystem. As a workaround, try using a different browser or
serving the files locally first (ie. run `npx http-server` from the
directory this README is in, then navigate in your browser to
`http://localhost:8080/testclient.html?~~localhost:8000`).

### Limitations

Even with a test key, the following things will fail in `testclient.html`:

+ Registering
+ Logging into other accounts (you can still switch to other unregistered
  accounts and back, though)

Everything else can be tested.

### Running a local login server (optional)

The client repository does **not** ship with a full login server, which is
why registration is normally disabled when you're just running the client
locally.  To make the register button work and have your accounts saved in a
(simple) database, we've added a tiny Node.js server that you can start
yourself.

If you also have the Pokémon Showdown **server** checked out next to this
repo, you can start everything at once using the `start-all` script described
below.

1. Install dependencies in the client directory:

   ```bash
   cd pokemon-showdown-client-master
   npm install
   # also run `npm install` in the server directory if you haven't already
   ```

2. Start the login/static server (or the whole stack):

   ```bash
   npm run start-login-server        # login server only (localhost:3000)
   npm run start-all                 # login server + main server
   ```

   When using `start-all`, the command will also invoke `npm run start` in
the sibling server checkout and pipe both processes' output to your console.
   The main server listens on `http://localhost:8000` by default; the client
   will use the login server on port 3000 automatically when you open the
   `/testclient.html` page.

   Opening the client is the same in either case: point your browser at
   `http://localhost:3000/testclient.html` (login server) or
   `http://localhost:8000/testclient.html` (main server).

3. You can now click **Register** and the account information will be stored
   in `users.db` in the client root.  You can also log in with the newly
   created account using the normal login popup.

   The toy login server hashes passwords with PBKDF2 and a per-user salt (the
   database schema will be automatically migrated if you have an older file).
   Usernames are validated, passwords must be at least 6 characters, and the
   server rate-limits registration attempts by IP.  These measures are
   purely for the local development server – the real public server uses a
   much stronger system and is not included here.

   (If you don't bother running the server at all, the client will now fall
   back to keeping a very simple set of accounts in `localStorage`; this is
   just for experimentation and doesn't persist across browsers.)

### Sharing replays

The local login server also accepts replay uploads.  After a battle you may
click **Upload and share replay**; the client will send the replay data to
`/action.php` and the server will save it in `replays/<id>.txt`.  A popup will
show the link where the replay can be viewed, e.g.

```
http://localhost:3000/replay/abcdef123
```

The server serves these URLs on-demand by embedding the log in a minimal HTML
wrapper and loading the normal `replay-embed.js` script from the client
bundle.  You can copy/paste the link to share the replay with others that
are running the same local server.

When the client detects it's being served from `localhost:3000`, it automatically
changes `Config.routes.replays` so that the URLs in the popup and the
"Download replay" button point at the local `/replay` route.

(If you run the client without the login server, uploading will still send a
request but fail; at that point you may fall back to downloading the replay
file manually.)

The server is intentionally minimal and insecure; it uses an sqlite database
with SHA256 password hashes and should **not** be used for anything exposed
on the public internet.  Its sole purpose is to let you try out the
registration UI while developing the client.

Warning
------------------------------------------------------------------------

This repository is not "batteries included". It does NOT include instructions
to run a full Pokémon Showdown login server, and we will not provide them.
Please do not ask for help on this; you will be turned away.

If you make a mistake hosting a login server, your users' passwords can get
stolen, so we do not want anyone to host a login server unless they can
figure out how to do it without help.

It also doesn't include several resource files (namely, the `/audio/` and
`/sprites/` directories) for size reasons.

On the other hand, as long as you don't want to run your own login server,
this repository contains everything you need to test changes to the client;
just see the "Testing" section above.

License
------------------------------------------------------------------------

Pokémon Showdown's client is distributed under the terms of the [AGPLv3][6].

The reason is mostly because I don't want low-effort proprietary forks that add bad code that steals everyone's passwords, or something like that.

If you're doing _anything_ else other than forking, _especially_ if you want to some client code files in your own open-source project that you want to release under a more permissive license (like, if you want to make your own multiplayer open-source game client for a different game), please ask at `staff@pokemonshowdown.com`. I hold all the copyright to the AGPLv3 parts and can relicense them to MIT for you.

  [6]: http://www.gnu.org/licenses/agpl-3.0.html

**WARNING:** This is **NOT** the same license as Pokémon Showdown's server.
