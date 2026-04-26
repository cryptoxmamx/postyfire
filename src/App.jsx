import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  BadgeCheck,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  Globe2,
  Link2,
  LoaderCircle,
  Music4,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Video,
  WandSparkles,
} from 'lucide-react'
import './App.css'

const platformHints = [
  'YouTube',
  'Instagram',
  'TikTok',
  'Facebook',
  'X',
  'Reddit',
  'Vimeo',
  'SoundCloud',
]

const trustPoints = [
  {
    icon: ShieldCheck,
    title: 'No API keys needed',
    copy: 'SaveBox.online works directly with yt-dlp, so you do not need paid third-party API access.',
  },
  {
    icon: WandSparkles,
    title: 'Simple 3-step flow',
    copy: 'Paste a link, pick a format, and download with a cleaner mobile-first layout.',
  },
  {
    icon: ArrowDownToLine,
    title: 'Video or audio presets',
    copy: 'Choose the best video, capped MP4 sizes, or audio-only exports without digging through technical options.',
  },
]

const howItWorks = [
  'Paste a public video link from your preferred platform.',
  'Preview the media and pick the easiest format for your device.',
  'SaveBox prepares the file, merges media when needed, and sends it to your browser.',
]

const faqItems = [
  {
    question: 'What can I download with SaveBox.online?',
    answer:
      'SaveBox.online is designed for public media URLs supported by yt-dlp, including many videos from YouTube, Instagram, TikTok, Facebook, X, Reddit, Vimeo, and more.',
  },
  {
    question: 'Does SaveBox.online support mobile downloads?',
    answer:
      'Yes. The interface is optimized for smaller screens so users can paste a link, select a format, and start a download with fewer taps.',
  },
  {
    question: 'Do I need an API key or account?',
    answer:
      'No. The downloader uses a self-hosted Express backend and the yt-dlp GitHub binary, so there are no external API keys required.',
  },
  {
    question: 'Can I download audio only?',
    answer:
      'Yes. SaveBox includes audio-only presets such as MP3 and M4A when the source supports them.',
  },
]

const seoSchema = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SaveBox.online',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    description:
      'SaveBox.online helps users download videos and audio from supported public social media links with a fast, mobile-friendly workflow.',
    url: 'https://savebox.online/',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  },
  {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  },
]

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

function formatDescription(text) {
  if (!text) {
    return 'Paste a public link to preview the media and choose the easiest download preset for your device.'
  }

  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function getDownloadButtonLabel(downloadState, downloadJob) {
  if (downloadState === 'loading') {
    if (downloadJob?.progressLabel) {
      return `${downloadJob.stage} ${downloadJob.progressLabel}`
    }

    return downloadJob?.stage || 'Preparing your download'
  }

  if (downloadState === 'success') {
    return 'Download another copy'
  }

  return 'Download selected format'
}

function SeoScripts() {
  return seoSchema.map((entry, index) => (
    <script
      key={index}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(entry) }}
    />
  ))
}

function App() {
  const [url, setUrl] = useState('')
  const [media, setMedia] = useState(null)
  const [selectedOptionId, setSelectedOptionId] = useState('')
  const [analyzeState, setAnalyzeState] = useState('idle')
  const [downloadState, setDownloadState] = useState('idle')
  const [downloadJob, setDownloadJob] = useState(null)
  const [completedJobId, setCompletedJobId] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const selectedOption = useMemo(
    () => media?.options.find((option) => option.id === selectedOptionId) || null,
    [media, selectedOptionId],
  )

  const stats = useMemo(() => {
    if (!media) {
      return []
    }

    return [
      media.durationText && {
        label: 'Duration',
        value: media.durationText,
        icon: Clock3,
      },
      media.hasVideo && {
        label: 'Top quality',
        value: media.maxHeight ? `Up to ${media.maxHeight}p` : 'Available',
        icon: Video,
      },
      media.audioFormatsCount && {
        label: 'Audio',
        value: `${media.audioFormatsCount} track options`,
        icon: Music4,
      },
    ].filter(Boolean)
  }, [media])

  const optionGroups = useMemo(() => {
    if (!media) {
      return []
    }

    return [
      {
        key: 'video',
        title: 'Video downloads',
        copy: 'Best when you want the full clip on phone, tablet, or desktop.',
        options: media.options.filter((option) => option.kind === 'video'),
      },
      {
        key: 'audio',
        title: 'Audio only',
        copy: 'Useful for music, interviews, podcasts, and offline listening.',
        options: media.options.filter((option) => option.kind === 'audio'),
      },
    ].filter((group) => group.options.length > 0)
  }, [media])

  const processingSteps = useMemo(
    () => [
      {
        title: 'Paste link',
        state: url.trim() ? 'done' : 'idle',
      },
      {
        title: 'Choose format',
        state:
          media && selectedOptionId
            ? 'done'
            : analyzeState === 'loading'
              ? 'active'
              : 'idle',
      },
      {
        title: 'Download file',
        state:
          downloadState === 'success'
            ? 'done'
            : downloadState === 'loading'
              ? 'active'
              : 'idle',
      },
    ],
    [analyzeState, downloadState, media, selectedOptionId, url],
  )

  useEffect(() => {
    if (!downloadJob?.id) {
      return undefined
    }

    if (['ready', 'error', 'completed'].includes(downloadJob.status)) {
      return undefined
    }

    let cancelled = false

    async function pollJob() {
      try {
        const response = await fetch(`/api/download-jobs/${downloadJob.id}`)
        const payload = await response.json()

        if (!response.ok) {
          throw new Error(payload.error || 'Unable to refresh the download status.')
        }

        if (cancelled) {
          return
        }

        setDownloadJob(payload)

        if (payload.status === 'error') {
          setDownloadState('error')
          setErrorMessage(payload.error || 'The download could not be prepared.')
        }
      } catch (error) {
        if (!cancelled) {
          setDownloadState('error')
          setErrorMessage(getErrorMessage(error))
        }
      }
    }

    pollJob()
    const timer = window.setInterval(pollJob, 1200)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [downloadJob?.id, downloadJob?.status])

  useEffect(() => {
    if (!downloadJob || downloadJob.status !== 'ready' || completedJobId === downloadJob.id) {
      return undefined
    }

    let cancelled = false

    async function fetchPreparedFile() {
      setDownloadState('loading')

      try {
        const response = await fetch(`/api/download-jobs/${downloadJob.id}/file`)

        if (!response.ok) {
          const payload = await response.json()
          throw new Error(payload.error || 'The prepared file could not be downloaded.')
        }

        if (cancelled) {
          return
        }

        const blob = await response.blob()
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        const contentDisposition = response.headers.get('Content-Disposition') || ''
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/)
        anchor.href = objectUrl
        anchor.download = filenameMatch?.[1] || `${media?.title || 'savebox-download'}.mp4`
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(objectUrl)
        setCompletedJobId(downloadJob.id)
        setDownloadState('success')
        setDownloadJob((current) =>
          current
            ? {
                ...current,
                status: 'completed',
                stage: 'Saved to your device',
                progress: 100,
                progressLabel: '100%',
                detail: 'Your file has been sent to the browser.',
              }
            : current,
        )
      } catch (error) {
        if (!cancelled) {
          setDownloadState('error')
          setErrorMessage(getErrorMessage(error))
        }
      }
    }

    fetchPreparedFile()

    return () => {
      cancelled = true
    }
  }, [completedJobId, downloadJob, media?.title])

  async function handlePasteFromClipboard() {
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error('Clipboard paste is not available in this browser.')
      }

      const clipboardText = await navigator.clipboard.readText()
      setUrl(clipboardText.trim())
      setErrorMessage('')
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function handleAnalyze(event) {
    event.preventDefault()

    if (!url.trim()) {
      setErrorMessage('Paste a full public video link first.')
      return
    }

    setAnalyzeState('loading')
    setDownloadState('idle')
    setDownloadJob(null)
    setCompletedJobId('')
    setErrorMessage('')

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      })

      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to analyze that link.')
      }

      setMedia(payload)
      setSelectedOptionId(payload.bestOptionId || payload.options[0]?.id || '')
      setAnalyzeState('success')
    } catch (error) {
      setMedia(null)
      setSelectedOptionId('')
      setAnalyzeState('error')
      setErrorMessage(getErrorMessage(error))
    }
  }

  async function handleDownload() {
    if (!media || !selectedOptionId) {
      setErrorMessage('Choose a format before starting the download.')
      return
    }

    setDownloadState('loading')
    setCompletedJobId('')
    setErrorMessage('')

    try {
      const response = await fetch('/api/download-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url,
          optionId: selectedOptionId,
        }),
      })

      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to start the download.')
      }

      setDownloadJob(payload)
    } catch (error) {
      setDownloadState('error')
      setErrorMessage(getErrorMessage(error))
    }
  }

  return (
    <main className="app-shell">
      <SeoScripts />

      <header className="site-header">
        <a className="brand-lockup" href="/" aria-label="SaveBox.online home">
          <img
            className="brand-logo"
            src="/savebox-logo.svg"
            alt="SaveBox.online logo"
            width="60"
            height="60"
          />
          <span>
            <strong>savebox.online</strong>
            <small>Smart downloads for social video links</small>
          </span>
        </a>

        <div className="header-pill">
          <BadgeCheck size={16} />
          Mobile-first video downloader
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-card">
          <span className="eyebrow">
            <Sparkles size={16} />
            SaveBox.online
          </span>
          <h1>Download videos from any supported platform with a cleaner, faster flow.</h1>
          <p className="hero-copy">
            SaveBox.online helps users download videos and audio from public social
            links with clearer options, better phone usability, and a friendlier
            download experience.
          </p>

          <div className="platform-strip" aria-label="Supported platforms">
            {platformHints.map((platform) => (
              <span key={platform}>{platform}</span>
            ))}
          </div>

          <div className="step-strip" aria-label="How SaveBox works">
            {processingSteps.map((step) => (
              <div className={`step-chip ${step.state}`} key={step.title}>
                <span />
                {step.title}
              </div>
            ))}
          </div>
        </div>

        <div className="control-grid">
          <form className="download-panel" onSubmit={handleAnalyze}>
            <div className="panel-heading">
              <h2>Paste your link</h2>
              <p>Preview the media first, then choose the easiest format to save.</p>
            </div>

            <label className="label" htmlFor="video-url">
              Video URL
            </label>

            <div className="input-wrap">
              <Link2 size={20} />
              <input
                id="video-url"
                name="url"
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>

            <div className="action-row">
              <button
                className="primary-button"
                type="submit"
                disabled={analyzeState === 'loading'}
              >
                {analyzeState === 'loading' ? (
                  <>
                    <LoaderCircle className="spin" size={18} />
                    Checking the link
                  </>
                ) : (
                  <>
                    <Sparkles size={18} />
                    Analyze link
                  </>
                )}
              </button>

              <button
                className="secondary-button"
                type="button"
                onClick={handlePasteFromClipboard}
              >
                <Clipboard size={18} />
                Paste
              </button>
            </div>

            <div className="helper-grid">
              <div className="helper-chip">
                <PlayCircle size={16} />
                Public links only
              </div>
              <div className="helper-chip">
                <Music4 size={16} />
                Video and audio presets
              </div>
              <div className="helper-chip">
                <Globe2 size={16} />
                Works across many yt-dlp supported sites
              </div>
            </div>
          </form>

          <aside className="format-sheet top-format-sheet">
            <div className="sheet-heading">
              <div>
                <span className="section-kicker">Choose your format</span>
                <h2>Download options stay right next to your link box</h2>
              </div>
              {downloadState === 'success' ? (
                <span className="success-pill">
                  <CheckCircle2 size={16} />
                  Download started
                </span>
              ) : null}
            </div>

            {media ? (
              optionGroups.map((group) => (
                <section className="option-group" key={group.key}>
                  <header className="option-group-header">
                    <div>
                      <h3>{group.title}</h3>
                      <p>{group.copy}</p>
                    </div>
                  </header>

                  <div className="option-list">
                    {group.options.map((option) => (
                      <label
                        className={`option-card${
                          selectedOptionId === option.id ? ' selected' : ''
                        }`}
                        key={option.id}
                      >
                        <input
                          type="radio"
                          name="download-option"
                          value={option.id}
                          checked={selectedOptionId === option.id}
                          onChange={() => setSelectedOptionId(option.id)}
                        />

                        <div className="option-copy">
                          <div className="option-topline">
                            <strong>{option.label}</strong>
                            <span>{option.ext.toUpperCase()}</span>
                          </div>
                          <p>{option.description}</p>
                          <div className="option-meta">
                            {option.badge ? <small>{option.badge}</small> : null}
                            {option.note ? <small>{option.note}</small> : null}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <div className="format-empty">
                <WandSparkles size={20} />
                <h3>Analyze a link to unlock the presets</h3>
                <p>
                  Video and audio download choices will appear here immediately,
                  so users do not need to scroll down looking for the format box.
                </p>
              </div>
            )}

            <button
              className="download-button"
              type="button"
              onClick={handleDownload}
              disabled={!media || !selectedOptionId || downloadState === 'loading'}
            >
              {downloadState === 'loading' ? (
                <>
                  <LoaderCircle className="spin" size={18} />
                  {getDownloadButtonLabel(downloadState, downloadJob)}
                </>
              ) : (
                <>
                  <Download size={18} />
                  {media ? getDownloadButtonLabel(downloadState, downloadJob) : 'Analyze a link first'}
                </>
              )}
            </button>
          </aside>
        </div>
      </section>

      {errorMessage ? (
        <div className="status-banner error">
          <AlertTriangle size={18} />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <section className="trust-grid">
        {trustPoints.map((item) => {
          const Icon = item.icon

          return (
            <article className="trust-card" key={item.title}>
              <Icon size={20} />
              <h2>{item.title}</h2>
              <p>{item.copy}</p>
            </article>
          )
        })}
      </section>

      <section className="process-card">
        <div className="process-header">
          <div>
            <span className="section-kicker">Download processing</span>
            <h2>Everything important stays visible while SaveBox prepares the file.</h2>
          </div>
          {downloadJob?.stage ? (
            <span className="progress-badge">
              <LoaderCircle className={downloadState === 'loading' ? 'spin' : ''} size={16} />
              {downloadJob.stage}
            </span>
          ) : (
            <span className="progress-badge idle">
              <CheckCircle2 size={16} />
              Ready for your next link
            </span>
          )}
        </div>

        <div className="process-body">
          <div className="progress-column">
            <div className="progress-track" aria-hidden="true">
              <span
                className="progress-fill"
                style={{ width: `${downloadJob?.progress || 0}%` }}
              />
            </div>
            <div className="progress-copy">
              <strong>
                {downloadJob?.progressLabel || (downloadState === 'success' ? '100%' : '0%')}
              </strong>
              <span>
                {downloadJob?.detail ||
                  'Analyze a link to see media details, then SaveBox will handle download preparation for you.'}
              </span>
            </div>
          </div>

          <ol className="how-list">
            {howItWorks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
      </section>

      {media ? (
        <section className="results-grid">
          <article className="media-card">
            <div className="media-image">
              {media.thumbnail ? (
                <img src={media.thumbnail} alt={media.title} />
              ) : (
                <div className="media-placeholder">
                  <Video size={28} />
                </div>
              )}
            </div>

            <div className="media-copy">
              <div className="media-topline">
                <span className="source-badge">{media.extractor}</span>
                <span className="domain-badge">{media.domain}</span>
              </div>
              <h2>{media.title}</h2>
              <p>{formatDescription(media.description)}</p>

              <div className="stats-grid">
                {stats.map((stat) => {
                  const Icon = stat.icon

                  return (
                    <div className="stat-card" key={stat.label}>
                      <Icon size={16} />
                      <span>{stat.label}</span>
                      <strong>{stat.value}</strong>
                    </div>
                  )
                })}
              </div>

              <div className="meta-row">
                <span>{media.uploader || 'Unknown uploader'}</span>
                <span>{media.domain}</span>
              </div>
            </div>
          </article>
        </section>
      ) : (
        <section className="empty-state">
          <Sparkles size={20} />
          <h2>Start with any supported public video link</h2>
          <p>
            SaveBox.online is set up to help users quickly find the right format,
            especially on phones where every extra tap matters.
          </p>
        </section>
      )}

      <section className="seo-grid">
        <article className="seo-card wide">
          <span className="section-kicker">SEO landing content</span>
          <h2>SaveBox.online is built for downloading videos from supported social platforms.</h2>
          <p>
            The landing page now clearly explains what the product does, who it is
            for, and how to use it. That gives search engines and users better
            context for queries around video downloading, audio extraction, and
            mobile-friendly download tools.
          </p>
        </article>

        <article className="seo-card">
          <h3>Why users like it</h3>
          <p>
            Cleaner option labels, fewer confusing choices, better mobile spacing,
            and progress feedback while files are being prepared.
          </p>
        </article>

        <article className="seo-card">
          <h3>What it supports</h3>
          <p>
            Video presets, audio-only downloads, thumbnail previews, responsive UI,
            structured SEO metadata, and server-managed file preparation.
          </p>
        </article>
      </section>

      <section className="faq-section">
        <div className="faq-header">
          <span className="section-kicker">FAQ</span>
          <h2>Answers users and search engines both need</h2>
        </div>

        <div className="faq-list">
          {faqItems.map((item) => (
            <article className="faq-card" key={item.question}>
              <h3>{item.question}</h3>
              <p>{item.answer}</p>
            </article>
          ))}
        </div>
      </section>

      {media ? (
        <div className="sticky-download-bar">
          <div>
            <strong>{selectedOption?.label || 'Choose a format'}</strong>
            <small>
              {downloadJob?.stage ||
                selectedOption?.description ||
                'Select the format that fits your device best.'}
            </small>
          </div>
          <button
            className="download-button compact"
            type="button"
            onClick={handleDownload}
            disabled={downloadState === 'loading'}
          >
            {downloadState === 'loading' ? (
              <>
                <LoaderCircle className="spin" size={18} />
                Working
              </>
            ) : (
              <>
                <Download size={18} />
                Download
              </>
            )}
          </button>
        </div>
      ) : null}
    </main>
  )
}

export default App
