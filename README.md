# Neonida

Game-style neon GPS for the web. Open `index.html` from any HTTPS host (GitHub Pages works); phones only share GPS with secure sites.

- Map: MapLibre GL (bundled in `vendor/`) with OpenFreeMap vector tiles and a custom neon style (`makeStyle()` in `app.js`).
- Directions: OSRM public demo server. Search: Photon. Both are free test services; switch to paid ones before a public launch.
- "Demo drive" simulates a trip across Miami so you can preview the app without driving.
