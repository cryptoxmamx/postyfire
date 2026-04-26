import express from 'express'
import ffmpegPath from 'ffmpeg-static'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist')
const binDir = path.join(projectRoot, 'bin')
const downloadDir = path.join(projectRoot, 'downloads')
const port = Number(process.env.PORT || 4000)
const ytDlpFileName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
const ytDlpPath = path.join(binDir, ytDlpFileName)
const ffmpegDir = ffmpegPath ? path.dirname(ffmpegPath) : null
const jobTtlMs = 1000 * 60 * 15

let ytDlpSetupPromise

const downloadJobs = new Map()
const app = express()

app.use(express.json({ limit: '1mb' }))

function isHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null
  }

  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60

  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
      .join(':')
  }

  return [minutes, remainingSeconds].map((part) => String(part).padStart(2, '0')).join(':')
}

function sanitizeFileName(value) {
  return String(value || 'savebox-download')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function getBestThumbnail(info) {
  if (typeof info.thumbnail === 'string' && info.thumbnail) {
    return info.thumbnail
  }

  if (!Array.isArray(info.thumbnails)) {
    return null
  }

  return [...info.thumbnails]
    .sort((left, right) => (right.width || 0) - (left.width || 0))
    .find((thumbnail) => thumbnail?.url)?.url || null
}

function getVideoHeights(formats) {
  return [...new Set(
    formats
      .filter((format) => format.vcodec && format.vcodec !== 'none' && Number.isFinite(format.height))
      .map((format) => format.height),
  )].sort((left, right) => right - left)
}

function buildDownloadOptions(info) {
  const formats = Array.isArray(info.formats) ? info.formats : []
  const heights = getVideoHeights(formats)
  const maxHeight = heights[0] || null
  const options = [
    {
      id: 'best-video',
      kind: 'video',
      label: 'Best available video',
      ext: 'mp4',
      badge: 'Recommended',
      note: 'Highest quality',
      description: 'Highest quality video with audio, merged automatically when needed.',
    },
  ]

  for (const target of [2160, 1440, 1080, 720, 480, 360]) {
    if (maxHeight && maxHeight >= target) {
      options.push({
        id: `mp4-${target}`,
        kind: 'video',
        label: `MP4 up to ${target}p`,
        ext: 'mp4',
        badge: target >= 720 ? 'Phone + desktop friendly' : 'Lightweight',
        note: 'Smaller file',
        description: `Prefer MP4 output and keep the download at or below ${target}p.`,
      })
    }
  }

  options.push(
    {
      id: 'audio-mp3',
      kind: 'audio',
      label: 'Audio only MP3',
      ext: 'mp3',
      badge: 'Audio',
      note: 'Portable format',
      description: 'Extract the best audio track and convert it to MP3.',
    },
    {
      id: 'audio-m4a',
      kind: 'audio',
      label: 'Audio only M4A',
      ext: 'm4a',
      badge: 'Audio',
      note: 'Smaller size',
      description: 'Keep the audio in a lightweight M4A download when possible.',
    },
  )

  return {
    options,
    bestOptionId: options[0]?.id || '',
    maxHeight,
    hasVideo: formats.some((format) => format.vcodec && format.vcodec !== 'none'),
    audioFormatsCount: formats.filter((format) => format.acodec && format.acodec !== 'none').length,
  }
}

function getOptionConfig(optionId) {
  if (optionId === 'best-video') {
    return {
      ext: 'mp4',
      kind: 'video',
      label: 'Best available video',
      args: [
        '-f',
        'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
        '--merge-output-format',
        'mp4',
      ],
    }
  }

  if (/^mp4-\d+$/.test(optionId)) {
    const height = Number(optionId.split('-')[1])
    return {
      ext: 'mp4',
      kind: 'video',
      label: `MP4 up to ${height}p`,
      args: [
        '-f',
        `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/b[height<=${height}][ext=mp4]/b[height<=${height}]`,
        '--merge-output-format',
        'mp4',
      ],
    }
  }

  if (optionId === 'audio-mp3') {
    return {
      ext: 'mp3',
      kind: 'audio',
      label: 'Audio only MP3',
      args: ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3'],
    }
  }

  if (optionId === 'audio-m4a') {
    return {
      ext: 'm4a',
      kind: 'audio',
      label: 'Audio only M4A',
      args: ['-f', 'bestaudio[ext=m4a]/bestaudio/best', '-x', '--audio-format', 'm4a'],
    }
  }

  return null
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function ensureYtDlpBinary() {
  if (ytDlpSetupPromise) {
    return ytDlpSetupPromise
  }

  ytDlpSetupPromise = (async () => {
    await ensureDirectory(binDir)

    const binaryExists = await fs
      .access(ytDlpPath)
      .then(() => true)
      .catch(() => false)

    if (binaryExists) {
      return ytDlpPath
    }

    const downloadUrl =
      process.platform === 'win32'
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
        : process.platform === 'darwin'
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'

    const response = await fetch(downloadUrl)

    if (!response.ok || !response.body) {
      throw new Error('Unable to download the yt-dlp binary from GitHub.')
    }

    await pipeline(response.body, createWriteStream(ytDlpPath))

    if (process.platform !== 'win32') {
      await fs.chmod(ytDlpPath, 0o755)
    }

    return ytDlpPath
  })()

  try {
    return await ytDlpSetupPromise
  } finally {
    ytDlpSetupPromise = undefined
  }
}

async function runYtDlp(args) {
  const binaryPath = await ensureYtDlpBinary()

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(stderr.trim() || stdout.trim() || `yt-dlp exited with code ${code}.`))
    })
  })
}

async function loadMediaInfo(url) {
  const { stdout } = await runYtDlp([
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    url,
  ])

  return JSON.parse(stdout)
}

async function removeFile(filePath) {
  if (!filePath) {
    return
  }

  try {
    await fs.rm(filePath, { force: true })
  } catch {
    return undefined
  }
}

function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    progressLabel: job.progressLabel,
    detail: job.detail,
    error: job.error,
    mediaTitle: job.mediaTitle,
    optionLabel: job.optionLabel,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function scheduleJobCleanup(jobId) {
  const job = downloadJobs.get(jobId)

  if (!job) {
    return
  }

  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer)
  }

  job.cleanupTimer = setTimeout(async () => {
    const latestJob = downloadJobs.get(jobId)

    if (!latestJob) {
      return
    }

    await removeFile(latestJob.filePath)
    downloadJobs.delete(jobId)
  }, jobTtlMs)

  job.cleanupTimer.unref?.()
}

function updateJob(jobId, patch) {
  const current = downloadJobs.get(jobId)

  if (!current) {
    return null
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }

  downloadJobs.set(jobId, next)
  return next
}

function createJob({ mediaTitle, optionLabel }) {
  const job = {
    id: randomUUID(),
    status: 'queued',
    stage: 'Queued',
    progress: 2,
    progressLabel: '2%',
    detail: 'SaveBox is preparing the download request.',
    error: '',
    filePath: '',
    fileName: '',
    mediaTitle,
    optionLabel,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cleanupTimer: null,
  }

  downloadJobs.set(job.id, job)
  scheduleJobCleanup(job.id)
  return job
}

function parseProgressLine(jobId, line) {
  const cleanedLine = line.trim()

  if (!cleanedLine) {
    return
  }

  if (/^[A-Za-z]:\\/.test(cleanedLine) || cleanedLine.startsWith('/')) {
    const fileName = path.basename(cleanedLine)
    updateJob(jobId, {
      filePath: cleanedLine,
      fileName,
    })
    return
  }

  if (cleanedLine.startsWith('download:')) {
    const [, percentRaw = '', speed = '', eta = ''] = cleanedLine.split('|')
    const numericPercent = Number(percentRaw.replace(/[^\d.]+/g, ''))
    const progress = Number.isFinite(numericPercent)
      ? Math.max(8, Math.min(97, Math.round(numericPercent)))
      : 22

    updateJob(jobId, {
      status: 'downloading',
      stage: 'Downloading media',
      progress,
      progressLabel: Number.isFinite(numericPercent) ? `${Math.round(numericPercent)}%` : 'Working',
      detail: [speed.trim(), eta.trim() && eta.trim() !== 'NA' ? `ETA ${eta.trim()}` : '']
        .filter(Boolean)
        .join(' · ') || 'Downloading the selected format.',
    })
    return
  }

  if (cleanedLine.startsWith('postprocess:')) {
    updateJob(jobId, {
      status: 'processing',
      stage: 'Processing file',
      progress: 96,
      progressLabel: '96%',
      detail: 'Merging video and audio or converting the file for download.',
    })
    return
  }

  if (
    cleanedLine.includes('[Merger]') ||
    cleanedLine.includes('[ExtractAudio]') ||
    cleanedLine.includes('[Fixup')
  ) {
    updateJob(jobId, {
      status: 'processing',
      stage: 'Processing file',
      progress: 94,
      progressLabel: '94%',
      detail: 'SaveBox is finishing the output so it downloads cleanly.',
    })
    return
  }

  if (cleanedLine.includes('[download]')) {
    updateJob(jobId, {
      status: 'downloading',
      stage: 'Downloading media',
      progress: 18,
      progressLabel: '18%',
      detail: 'Fetching source media from the selected platform.',
    })
  }
}

function attachLineReader(stream, onLine) {
  let buffer = ''

  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''

    for (const line of lines) {
      onLine(line)
    }
  })

  stream.on('end', () => {
    if (buffer.trim()) {
      onLine(buffer)
    }
  })
}

async function startDownloadJob({ jobId, url, option }) {
  const binaryPath = await ensureYtDlpBinary()
  const outputTemplate = path.join(downloadDir, '%(title).120B-%(id)s.%(ext)s')
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--windows-filenames',
    '--restrict-filenames',
    '--newline',
    '--progress',
    '--progress-template',
    'download:download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--progress-template',
    'postprocess:postprocess:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--output',
    outputTemplate,
    ...option.args,
    '--print',
    'after_move:filepath',
  ]

  if (ffmpegDir) {
    args.push('--ffmpeg-location', ffmpegDir)
  }

  args.push(url)

  updateJob(jobId, {
    status: 'downloading',
    stage: 'Starting download',
    progress: 6,
    progressLabel: '6%',
    detail: 'SaveBox is connecting to the source and preparing the file.',
  })

  await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    attachLineReader(child.stdout, (line) => parseProgressLine(jobId, line))
    attachLineReader(child.stderr, (line) => parseProgressLine(jobId, line))

    child.once('error', reject)
    child.once('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}.`))
        return
      }

      const finishedJob = downloadJobs.get(jobId)

      if (!finishedJob?.filePath) {
        reject(new Error('The file finished processing but its location could not be found.'))
        return
      }

      updateJob(jobId, {
        status: 'ready',
        stage: 'Ready to download',
        progress: 100,
        progressLabel: '100%',
        detail: 'The file is prepared and being sent to your browser.',
      })

      resolve()
    })
  })
}

app.get('/api/health', async (_request, response) => {
  const binaryExists = await fs
    .access(ytDlpPath)
    .then(() => true)
    .catch(() => false)

  response.json({
    status: 'ok',
    binaryExists,
    activeJobs: downloadJobs.size,
  })
})

app.post('/api/analyze', async (request, response) => {
  try {
    const url = String(request.body?.url || '').trim()

    if (!isHttpUrl(url)) {
      response.status(400).json({
        error: 'Please provide a valid public http or https link.',
      })
      return
    }

    const info = await loadMediaInfo(url)
    const computed = buildDownloadOptions(info)

    response.json({
      title: info.title || 'Untitled media',
      description: info.description || '',
      thumbnail: getBestThumbnail(info),
      uploader: info.uploader || info.channel || info.creator || '',
      extractor: info.extractor_key || info.extractor || 'yt-dlp',
      domain: info.webpage_url_domain || new URL(url).hostname,
      durationText: formatDuration(info.duration),
      ...computed,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to inspect that media link.',
    })
  }
})

app.post('/api/download-jobs', async (request, response) => {
  try {
    const url = String(request.body?.url || '').trim()
    const optionId = String(request.body?.optionId || '').trim()

    if (!isHttpUrl(url)) {
      response.status(400).json({
        error: 'Please provide a valid public http or https link.',
      })
      return
    }

    const option = getOptionConfig(optionId)

    if (!option) {
      response.status(400).json({
        error: 'That download option is not supported.',
      })
      return
    }

    await ensureDirectory(downloadDir)
    const info = await loadMediaInfo(url)
    const job = createJob({
      mediaTitle: info.title || 'Untitled media',
      optionLabel: option.label,
    })

    startDownloadJob({
      jobId: job.id,
      url,
      option,
    }).catch((error) => {
      updateJob(job.id, {
        status: 'error',
        stage: 'Download failed',
        progress: 100,
        progressLabel: 'Error',
        error: error instanceof Error ? error.message : 'The download failed unexpectedly.',
        detail: 'SaveBox could not prepare this file.',
      })
    })

    response.status(202).json(serializeJob(job))
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to start the download job.',
    })
  }
})

app.get('/api/download-jobs/:jobId', (request, response) => {
  const job = downloadJobs.get(request.params.jobId)

  if (!job) {
    response.status(404).json({
      error: 'Download job not found.',
    })
    return
  }

  response.json(serializeJob(job))
})

app.get('/api/download-jobs/:jobId/file', async (request, response) => {
  const job = downloadJobs.get(request.params.jobId)

  if (!job) {
    response.status(404).json({
      error: 'Download job not found.',
    })
    return
  }

  if (job.status !== 'ready' && job.status !== 'completed') {
    response.status(409).json({
      error: 'The file is not ready to download yet.',
    })
    return
  }

  const fallbackName = `${sanitizeFileName(job.mediaTitle)}.${sanitizeFileName(
    path.extname(job.fileName || `file.${job.optionLabel || 'mp4'}`),
  ).replace(/^\./, '') || 'mp4'}`

  response.download(job.filePath, job.fileName || fallbackName, async () => {
    await removeFile(job.filePath)
    downloadJobs.delete(job.id)
  })
})

await ensureDirectory(downloadDir)

const distExists = await fs
  .access(path.join(distDir, 'index.html'))
  .then(() => true)
  .catch(() => false)

if (distExists) {
  app.use(express.static(distDir))

  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`SaveBox.online server listening on http://localhost:${port}`)
})
