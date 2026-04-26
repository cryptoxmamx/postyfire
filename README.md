# SaveBox.online

SaveBox.online is a full-stack social media video downloader built with React, Vite, and Express. It uses the `yt-dlp` GitHub binary directly for YouTube and many other public social links, so there are no third-party API keys involved.

## Run locally

```bash
npm install
npm run dev
```

Frontend runs through Vite and the backend runs on port `4000`. API calls are proxied through `/api` in development.

## Production build

```bash
npm run build
npm start
```

The server automatically downloads the right `yt-dlp` binary into `bin/` on first run, uses bundled `ffmpeg-static` for merged video/audio and audio conversions, and now exposes job-based download progress endpoints for a smoother UI.

## Notes

- Works best with public URLs that `yt-dlp` supports.
- Download only content you own or are allowed to save.
- Downloaded files are prepared as server jobs, streamed back to the browser, and cleaned up after the transfer finishes.
- SEO assets are included through `index.html`, `robots.txt`, `sitemap.xml`, `site.webmanifest`, and on-page structured content.
