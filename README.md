# SYNCBOARD

One board. Every screen. Live.

A real-time collaborative drawing app built with React, Vite, Express, and Socket.IO.

## Features

- Create a board and get a short join code
- Join from another device with a QR code or code entry
- Real-time whiteboard drawing sync across devices
- Pen, eraser, colors, size, undo, redo, clear, save export
- Black and white themes with local persistence
- Responsive mobile and desktop layouts

## Local setup

1. Install dependencies:
   - `npm install --prefix server`
   - `npm install --prefix client`
2. Copy `.env.example` to `.env` in the root and update values if needed.
3. Start the app:
   - `npm run dev`
4. Open the frontend in the browser at `http://localhost:5173`

## Production build

- `npm run build`

## Server only

- `npm run server`

## Client only

- `npm run client`

## Notes

- The frontend uses the `VITE_SERVER_URL` environment variable.
- Board state is stored in memory for the MVP, so board data resets when the backend restarts.
- QR codes use a join URL that includes the short board code.
