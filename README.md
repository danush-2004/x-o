# kalakal.in

Multiplayer game site: make a lobby, share the 4-letter code, the host picks a game
(XO or LUDO) and starts the match. Node.js + WebSockets, no database.

## Run on your computer
    npm install
    npm start
Open http://localhost:3000 in two browser tabs.

## Put it online
Upload this folder's contents to your GitHub repo (server.js, package.json, README.md and the public folder),
then deploy on Render: Build command `npm install`, Start command `npm start`.

## Use your own domain (kalakal.in)
1. Buy the domain from any registrar.
2. In Render: your service > Settings > Custom Domains > Add `kalakal.in`.
3. Add the DNS records Render shows you at your registrar, then wait for HTTPS to turn on.
