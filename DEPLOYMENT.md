# Deployment Guide for SyncWave Downloader

To take this project live, you have several options. The most reliable way is using **Docker** or a platform like **Railway/Render** because of the specific requirements for `ffmpeg` and `yt-dlp`.

---

## Preparation: Build the Frontend
Before deploying, you need to compile the frontend so the backend can serve it.
```bash
cd frontend
npm install
npm run build
```
This creates a `dist/` folder that the backend is now configured to serve automatically.

---

## Option 1: Railway (Easiest & Recommended)
Railway handles Node.js projects extremely well.
1.  Push your code to a GitHub repository.
2.  Connect your repository to [Railway.app](https://railway.app/).
3.  Add a **Variable** called `PORT` and set it to `5001`.
4.  Railway will automatically detect the `package.json` in the root and start the server.

---

## Option 2: Docker (Most Reliable)
Docker ensures that `ffmpeg` and `yt-dlp` work exactly the same way as they do on your machine.
Create a `Dockerfile` in the root:

```dockerfile
# Use Node.js base
FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y python3 curl ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy all files
COPY . .

# Install dependencies
RUN npm install
RUN npm run setup:backend
RUN npm run setup:frontend

# Build frontend
RUN cd frontend && npm run build

EXPOSE 5001
CMD ["npm", "run", "dev:backend"]
```

---

## Option 3: VPS (DigitalOcean / Linode)
If you have a Linux server:
1.  **Clone** the repo.
2.  **Install FFmpeg**: `sudo apt install ffmpeg`
3.  **Setup**: Run `npm run setup` in the root.
4.  **Build**: `cd frontend && npm run build`
5.  **Run with PM2**:
    ```bash
    npm install -g pm2
    cd backend
    pm2 start server.js --name "syncwave"
    ```

---

## Important Note on Hosting
YouTube downloaders can sometimes be flagged by hosting providers if they receive DMCA requests or if the provider's TOS forbids it. 
- **Personal Use**: These platforms are great.
- **Public Use**: Be mindful of the terms of service of the platform you choose.
