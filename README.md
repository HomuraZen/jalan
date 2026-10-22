# Jalan — personal offline navigator

A phone app (PWA) that installs to your home screen and gives turn-by-turn voice navigation, including with zero signal on routes you saved beforehand.

## What works where

| Feature | Online | Offline |
|---|---|---|
| Search places (Malaysia) | ✅ | Saved places, offline routes, coordinates only |
| Road routing | ✅ | Saved routes only |
| Turn-by-turn + voice (EN / BM) | ✅ | ✅ on saved routes |
| Map display | ✅ | Along saved routes + areas you've browsed |
| Off-route | Auto-reroute | Warns + arrow back to route |
| Unsaved destination | — | Straight-line direction mode |
| Reports (police, camera, flood, jam…) with voice alerts | ✅ | ✅ |
| Speed warning | ✅ | ✅ |

## Install (GitHub Pages, ~5 minutes)

1. github.com → **New repository** → name it `jalan` → Public → Create.
2. **Add file → Upload files** → drag in everything inside this folder (keep the `icons/` and `vendor/` folders) → Commit.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
4. After ~1 minute open `https://<your-username>.github.io/jalan/` on your phone.
5. Add to home screen: Android Chrome → ⋮ → *Install app*. iPhone Safari → Share → *Add to Home Screen*.
6. Open it from the home-screen icon, allow Location.

It must be served over HTTPS (GitHub Pages does this). Opening `index.html` directly from a file will not work.

## Daily use

1. While you have signal, search the destination → **⬇ Offline** → name it. Wait for the bar to finish.
2. Later, with no signal: ⬇ **Offline routes** → tap the route → **Start**.
3. Tap the orange **!** button to mark police, cameras, floods, potholes etc. You get a voice warning when you approach them next time.

## Limits (be honest with yourself)

- Routing and search need signal. Offline you can only drive routes saved in advance.
- No live traffic. That needs a server and other users sending data.
- Keep the app open with the screen on while driving (it keeps the screen awake). Web apps cannot track GPS with the screen locked.
- iPhone: install to home screen, or iOS may delete stored maps after ~7 days of not using the app.
- Free OpenStreetMap tiles and the OSRM demo router are for light personal use. If you share the app widely, switch to a paid/free-key tile provider (Settings → Advanced) and your own routing server.

## Files

`index.html` page · `app.js` all logic · `app.css` design · `sw.js` offline engine · `manifest.webmanifest` install info · `vendor/leaflet` map library · `icons/`.
