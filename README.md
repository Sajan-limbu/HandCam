# Limbu Itahari Gesture Map

Static OpenStreetMap + deck.gl map focused on Itahari, Nepal with webcam hand gestures.

## Local run

```powershell
cd "C:\Users\limbu\Documents\New project"
python -m http.server 8000
```

Open `http://localhost:8000`.

## Files

- `index.html`
- `styles.css`
- `app.js`
- `logo.png`
- `vercel.json`

## Gestures

- One raised index finger rotates and tilts the map
- Two hands control zoom using the distance between them

## Deploy

This project is static and can be deployed directly to:

- Netlify
- Vercel static hosting
- GitHub Pages
- Any basic web server

Deploy the contents of this folder as-is.

## Vercel

1. Push this folder to a Git repository.
2. Import the repository into Vercel.
3. Framework preset: `Other`
4. Build command: leave empty
5. Output directory: leave empty
6. Deploy

Vercel will serve the static files directly.

## Git

Example commands:

```powershell
git add .
git commit -m "Prepare Limbu Itahari map for Vercel deployment"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

## Compatibility notes

- Webcam gestures require HTTPS or `localhost`
- Modern Chromium browsers are the best target for webcam + hand tracking
- Firefox and Safari support may vary depending on webcam/media and CDN module behavior
- The layout is responsive and stacks into a single column on smaller screens
