import { useState, useRef, useCallback, useEffect } from 'react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import './App.css'

import { FORMAT_MODES, MODEL_PROVIDERS, CLASSIC_MODEL_PROVIDERS } from './constants'
import ResultPage from './Result.jsx'
import TemplateEditor from './TemplateEditor.jsx'
import BillDetectPage from './bill_detect.jsx'

// ─── Shared progress-bar hook ─────────────────────────────────────────────────
// Simulates smooth OCR progress since the backend doesn't stream progress.
// Eases to ~88% while loading, then jumps to 100 on done.
function useProgress(isLoading) {
  const [progress, setProgress] = useState(0)
  const timerRef = useRef(null)

  useEffect(() => {
    if (isLoading) {
      setProgress(0)
      const start = Date.now()
      // target 88% asymptotically over ~120 s
      timerRef.current = setInterval(() => {
        const elapsed = (Date.now() - start) / 1000
        // logistic-like curve: reaches ~88% at 120 s
        const p = 88 * (1 - Math.exp(-elapsed / 40))
        setProgress(p)
      }, 300)
    } else {
      clearInterval(timerRef.current)
      // jump to 100, then hide after short delay
      setProgress(v => v > 0 ? 100 : 0)
      const t = setTimeout(() => setProgress(0), 600)
      return () => clearTimeout(t)
    }
    return () => clearInterval(timerRef.current)
  }, [isLoading])

  return progress
}

// ─── Shared ProgressBar component ────────────────────────────────────────────
function ProgressBar({ progress, label }) {
  if (progress <= 0) return null
  const pct = Math.min(100, Math.round(progress))
  return (
    <div className="ocr-progress-wrap">
      <div className="ocr-progress-header">
        <span className="ocr-progress-label">{label || 'AI 辨識中…'}</span>
        <span className="ocr-progress-pct">{pct}%</span>
      </div>
      <div className="ocr-progress-track">
        <div
          className={`ocr-progress-fill${pct >= 100 ? ' done' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ─── Upload / Home Page ───────────────────────────────────────────────────────
function UploadPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('ai')   // 'ai' | 'classic' | 'auto'

  return (
    <div className="page upload-page">
      {/* Header */}
      <header className="app-header">
        <div className="logo-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="M7 8h10M7 12h7M7 16h5" />
          </svg>
        </div>
        <div>
          <h1 className="app-title">OCR 智慧辨識</h1>
          <p className="app-sub">上傳圖片、PDF，AI 智慧分析並還原內容</p>
        </div>
      </header>

      {/* Quick-nav row */}
      <div className="home-nav-row">
        <button onClick={() => navigate('/result')} className="btn-back" style={{ padding: '6px 12px', fontSize: '0.83rem' }}>
          📋 歷史紀錄 ➔
        </button>
        <button onClick={() => navigate('/template')} className="btn-back" style={{ padding: '6px 12px', fontSize: '0.83rem' }}>
          📐 模板編輯器 ➔
        </button>
        {/* <button onClick={() => navigate('/bill-detect')} className="btn-back" style={{ padding: '6px 12px', fontSize: '0.83rem', color: '#fbbf24', borderColor: 'rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.08)' }}>
          🧾 發票識別 ➔
        </button> */}
      </div>

      {/* Mode tab switcher */}
      <div className="home-tabs">
        <button
          className={`home-tab-btn ${tab === 'ai' ? 'active' : ''}`}
          onClick={() => setTab('ai')}
        >
          🤖 AI 模式
        </button>
        <button
          className={`home-tab-btn ${tab === 'classic' ? 'active' : ''}`}
          onClick={() => setTab('classic')}
        >
          🎯 經典模式
        </button>
        <button
          className={`home-tab-btn ${tab === 'auto' ? 'active' : ''}`}
          onClick={() => setTab('auto')}
        >
          🔍 自動識別
        </button>
      </div>

      {tab === 'ai' && <AIPanel navigate={navigate} />}
      {tab === 'classic' && <ClassicPanel navigate={navigate} />}
      {tab === 'auto' && <AutoPanel navigate={navigate} />}
    </div>
  )
}

// ─── AI Panel (original full feature set) ────────────────────────────────────
function AIPanel({ navigate }) {
  const [selectedFile, setSelectedFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [mode, setMode] = useState('business_card')
  const [optimized, setOptimized] = useState(false)
  const [provider, setProvider] = useState('gemini')
  const abortRef = useRef(null)
  const inputRef = useRef(null)
  const carouselRef = useRef(null)
  const progress = useProgress(isLoading)

  const scrollCarousel = (dir) =>
    carouselRef.current?.scrollBy({ left: dir * 210, behavior: 'smooth' })

  const setFile = (file) => {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!file.type.startsWith('image/') && !isPdf) {
      setError('請選擇有效的圖片（JPG、PNG…）或 PDF 檔案')
      return
    }
    setSelectedFile(file)
    setPreviewUrl(file.type.startsWith('image/') ? URL.createObjectURL(file) : null)
    setError(null)
  }

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setIsDragging(false)
    setFile(e.dataTransfer.files[0])
  }, [])

  const handleUpload = async () => {
    if (!selectedFile) return
    setIsLoading(true); setError(null)
    const formData = new FormData()
    formData.append('image', selectedFile)
    formData.append('mode', mode)
    formData.append('optimized', optimized ? 'true' : 'false')
    formData.append('provider', provider)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('http://127.0.0.1:8000/api/recognize-text', {
        method: 'POST', body: formData, signal: controller.signal,
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || '辨識失敗') }
      const data = await res.json()
      navigate('/result', {
        state: {
          result: {
            html: data.html || null, json_text: data.json_text || null,
            mode: data.mode || mode, optimized, provider,
            filename: selectedFile.name, previewUrl,
          }
        }
      })
    } catch (err) {
      setError(err.name === 'AbortError' ? '已取消辨識' : (err.message || '發生錯誤'))
    } finally { setIsLoading(false); abortRef.current = null }
  }

  return (
    <>
      {/* Model selector */}
      <div className="model-selector-row">
        <span className="model-selector-label">模型</span>
        <select className="model-select" value={provider} onChange={e => setProvider(e.target.value)}>
          {MODEL_PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      {/* Format mode carousel */}
      <div className="mode-selector">
        <p className="mode-label">辨識模式</p>
        <div className="mode-carousel-wrap">
          <button className="carousel-arrow left" onClick={() => scrollCarousel(-1)} aria-label="向左">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div className="mode-options" ref={carouselRef}>
            {FORMAT_MODES.map(m => (
              <button key={m.key} className={`mode-btn ${mode === m.key ? 'active' : ''}`} onClick={() => setMode(m.key)}>
                <span className="mode-btn-label">{m.label}</span>
                <span className="mode-btn-desc">{m.desc}</span>
              </button>
            ))}
          </div>
          <button className="carousel-arrow right" onClick={() => scrollCarousel(1)} aria-label="向右">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 18l6-6-6-6" /></svg>
          </button>
        </div>
      </div>

      {/* Optimized toggle */}
      <div className={`optimized-toggle-row${optimized ? ' on' : ''}`} onClick={() => setOptimized(v => !v)}>
        <div className="optimized-toggle-info">
          <span className="optimized-toggle-label">⚡ 優化模式</span>
          <span className="optimized-toggle-desc">啟動後全部模式強制切片、逐區深度分析，提升辨識準確率</span>
        </div>
        <div className={`toggle-switch${optimized ? ' on' : ''}`}><div className="toggle-thumb" /></div>
      </div>

      {/* Drop zone */}
      <div
        className={`drop-zone ${isDragging ? 'dragging' : ''} ${previewUrl ? 'has-preview' : ''}`}
        onDrop={handleDrop}
        onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onClick={() => !previewUrl && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept="image/*,application/pdf" className="hidden-input"
          onChange={e => setFile(e.target.files[0])} />
        {previewUrl ? (
          <div className="preview-wrap">
            <img src={previewUrl} alt="preview" className="preview-img" />
            <div className="preview-overlay">
              <span className="preview-filename">{selectedFile?.name}</span>
              <button className="btn-change" onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>更換檔案</button>
            </div>
          </div>
        ) : selectedFile ? (
          <div className="pdf-preview">
            <div className="pdf-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="9" y1="13" x2="15" y2="13" />
                <line x1="9" y1="17" x2="13" y2="17" />
              </svg>
              <span className="pdf-label">PDF</span>
            </div>
            <p className="pdf-filename">{selectedFile.name}</p>
            <button className="btn-change" onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>更換檔案</button>
          </div>
        ) : (
          <div className="drop-hint">
            <div className="drop-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p className="drop-text">拖曳圖片到這裡</p>
            <p className="drop-sub">或點擊此處選擇檔案</p>
            <span className="drop-formats">JPG · PNG · PDF</span>
          </div>
        )}
      </div>

      <ProgressBar progress={progress} label="AI 分析中…" />

      {/* Action */}
      <div className="action-row">
        <button className={`btn-primary ${isLoading ? 'btn-loading' : ''}`}
          onClick={handleUpload} disabled={!selectedFile || isLoading}>
          {isLoading ? <><span className="spinner" />AI 分析中…</> : <><span className="btn-icon">✦</span>開始 AI 分析</>}
        </button>
        {isLoading && <button className="btn-cancel" onClick={() => abortRef.current?.abort()}>✕ 取消</button>}
      </div>

      {error && <div className="error-banner"><span>⚠</span> {error}</div>}
    </>
  )
}

// ─── Auto-detect Panel ─────────────────────────────────────────────
function AutoPanel({ navigate }) {
  const [selectedFile, setSelectedFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [provider, setProvider] = useState('gemma')
  const [matchInfo, setMatchInfo] = useState(null)
  const [step, setStep] = useState('')
  const inputRef = useRef(null)
  const abortRef = useRef(null)
  const progress = useProgress(isLoading)

  const setFile = (file) => {
    if (!file) return
    const isImg = file.type.startsWith('image/')
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isImg && !isPdf) { setError('請選擇圖片（JPG / PNG）或 PDF'); return }
    setSelectedFile(file)
    setPreviewUrl(isImg ? URL.createObjectURL(file) : null)
    setError(null)
    setMatchInfo(null)
    setStep('')
  }

  const handleRun = async () => {
    if (!selectedFile) { setError('請先選擇檔案'); return }
    setIsLoading(true); setError(null); setMatchInfo(null)
    setStep('matching')
    const fd = new FormData()
    fd.append('image', selectedFile)
    fd.append('provider', provider)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('http://127.0.0.1:8000/api/auto-detect-ocr', {
        method: 'POST', body: fd, signal: controller.signal,
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || '識別失敗') }
      const data = await res.json()
      setMatchInfo({ matched_template: data.matched_template, scores: data.scores })
      navigate('/result', {
        state: {
          result: {
            json_text: data.json_text || null,
            mode: '自動識別',
            optimized: false,
            provider,
            filename: selectedFile.name,
            previewUrl,
            matched_template: data.matched_template,
          }
        }
      })
    } catch (err) {
      setError(err.name === 'AbortError' ? '已取消' : (err.message || '發生錯誤'))
    } finally { setIsLoading(false); abortRef.current = null; setStep('') }
  }

  return (
    <div className="classic-panel">
      <div className="model-selector-row">
        <span className="model-selector-label">模型</span>
        <select className="model-select" value={provider} onChange={e => setProvider(e.target.value)}>
          {CLASSIC_MODEL_PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>

      <div className="auto-info-card">
        <span className="auto-info-icon">🔍</span>
        <div>
          <p className="auto-info-title">自動比對模板</p>
          <p className="auto-info-desc">
            上傳檔案後，系統會自動裁切每個模板的「🔑 判斷點」區域、透過 AI 識別文字內容，
            找出文字最豐富的模板作為比對結果，再對對應區域執行完整 OCR。
          </p>
          <p className="auto-info-hint">
            💡 請先在『📐 模板編輯器』中為每個模板設定至少一個 <strong>🔑 判斷點</strong>
          </p>
        </div>
      </div>

      <div
        className={`drop-zone ${isDragging ? 'dragging' : ''} ${previewUrl || (selectedFile && !previewUrl) ? 'has-preview' : ''}`}
        onDrop={e => { e.preventDefault(); setIsDragging(false); setFile(e.dataTransfer.files[0]) }}
        onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onClick={() => !selectedFile && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept="image/*,application/pdf" className="hidden-input"
          onChange={e => setFile(e.target.files[0])} />
        {previewUrl ? (
          <div className="preview-wrap">
            <img src={previewUrl} alt="preview" className="preview-img" />
            <div className="preview-overlay">
              <span className="preview-filename">{selectedFile?.name}</span>
              <button className="btn-change" onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>更換圖片</button>
            </div>
          </div>
        ) : selectedFile ? (
          <div className="pdf-preview">
            <div className="pdf-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="9" y1="13" x2="15" y2="13" />
                <line x1="9" y1="17" x2="13" y2="17" />
              </svg>
              <span className="pdf-label">PDF</span>
            </div>
            <p className="pdf-filename">{selectedFile.name}</p>
            <button className="btn-change" onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>更換檔案</button>
          </div>
        ) : (
          <div className="drop-hint">
            <div className="drop-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p className="drop-text">拖曳或點擊選擇檔案</p>
            <p className="drop-sub">系統將自動比對模板完成識別</p>
            <span className="drop-formats">JPG · PNG · PDF</span>
          </div>
        )}
      </div>

      <ProgressBar progress={progress} label="自動比對識別中…" />

      <div className="action-row">
        <button className={`btn-primary ${isLoading ? 'btn-loading' : ''}`}
          onClick={handleRun} disabled={!selectedFile || isLoading}>
          {isLoading
            ? <><span className="spinner" />自動識別中…</>
            : <><span className="btn-icon">🔍</span>開始自動識別</>}
        </button>
        {isLoading && <button className="btn-cancel" onClick={() => abortRef.current?.abort()}>✕ 取消</button>}
      </div>

      {error && <div className="error-banner"><span>⚠</span> {error}</div>}
    </div>
  )
}

// ─── Classic Panel ────────────────────────────────────────────────────────────
function ClassicPanel({ navigate }) {
  const [templates, setTemplates] = useState([])
  const [selectedTpl, setSelectedTpl] = useState('')
  const [provider, setProvider] = useState('gemma')
  const [selectedFile, setSelectedFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [results, setResults] = useState(null)
  const inputRef = useRef(null)
  const abortRef = useRef(null)
  const progress = useProgress(isLoading)

  useEffect(() => {
    fetch('http://127.0.0.1:8000/api/templates')
      .then(r => r.json())
      .then(data => { setTemplates(data); if (data.length && !selectedTpl) setSelectedTpl(data[0].name) })
      .catch(() => { })
  }, [])

  const setFile = (file) => {
    if (!file) { setError('請選擇圖片檔案'); return }
    const isImg = file.type.startsWith('image/')
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    if (!isImg && !isPdf) { setError('請選擇圖片（JPG / PNG）或 PDF）'); return }
    setSelectedFile(file)
    setPreviewUrl(isImg ? URL.createObjectURL(file) : null)
    setError(null)
    setResults(null)
  }

  const handleRun = async () => {
    if (!selectedFile) { setError('請先選擇圖片'); return }
    if (!selectedTpl) { setError('請選擇一個模板'); return }
    setIsLoading(true); setError(null); setResults(null)
    const fd = new FormData()
    fd.append('image', selectedFile)
    fd.append('template_name', selectedTpl)
    fd.append('provider', provider)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('http://127.0.0.1:8000/api/classic-ocr', {
        method: 'POST', body: fd, signal: controller.signal,
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || '辨識失敗') }
      const data = await res.json()

      navigate('/result', {
        state: {
          result: {
            json_text: data.json_text || null,
            mode: '經典模式',
            optimized: false,
            provider,
            filename: selectedFile.name,
            previewUrl,
          }
        }
      })
    } catch (err) {
      setError(err.name === 'AbortError' ? '已取消' : (err.message || '發生錯誤'))
    } finally { setIsLoading(false); abortRef.current = null }
  }

  return (
    <div className="classic-panel">
      {templates.length === 0 ? (
        <div className="classic-no-template">
          <p>尚無儲存的模板</p>
          <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => navigate('/template')}>
            📐 前往建立模板
          </button>
        </div>
      ) : (
        <>
          <div className="classic-controls">
            <div className="model-selector-row" style={{ marginBottom: 0 }}>
              <span className="model-selector-label">模板</span>
              <select className="model-select" value={selectedTpl} onChange={e => setSelectedTpl(e.target.value)}>
                {templates.map(t => (
                  <option key={t.name} value={t.name}>{t.name}（{t.region_count} 個區域）</option>
                ))}
              </select>
            </div>
            <div className="model-selector-row" style={{ marginBottom: 0 }}>
              <span className="model-selector-label">模型</span>
              <select className="model-select" value={provider} onChange={e => setProvider(e.target.value)}>
                {CLASSIC_MODEL_PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>
            <button className="te-link-btn" onClick={() => navigate('/template')}
              style={{ alignSelf: 'center', paddingTop: 4 }}>
              管理模板 →
            </button>
          </div>

          <div
            className={`drop-zone ${isDragging ? 'dragging' : ''} ${previewUrl || (selectedFile && !previewUrl) ? 'has-preview' : ''}`}
            onDrop={e => { e.preventDefault(); setIsDragging(false); setFile(e.dataTransfer.files[0]) }}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            onClick={() => !selectedFile && inputRef.current?.click()}
          >
            <input ref={inputRef} type="file" accept="image/*,application/pdf" className="hidden-input"
              onChange={e => setFile(e.target.files[0])} />
            {previewUrl ? (
              <div className="preview-wrap">
                <img src={previewUrl} alt="preview" className="preview-img" />
                <div className="preview-overlay">
                  <span className="preview-filename">{selectedFile?.name}</span>
                  <button className="btn-change" onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>更換圖片</button>
                </div>
              </div>
            ) : selectedFile ? (
              <div className="pdf-preview">
                <div className="pdf-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="9" y1="13" x2="15" y2="13" />
                    <line x1="9" y1="17" x2="13" y2="17" />
                  </svg>
                  <span className="pdf-label">PDF</span>
                </div>
                <p className="pdf-filename">{selectedFile.name}</p>
                <button className="btn-change" onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>更換檔案</button>
              </div>
            ) : (
              <div className="drop-hint">
                <div className="drop-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <p className="drop-text">拖曳或點擊選擇檔案</p>
                <p className="drop-sub">依模板裁切後送 AI 辨識</p>
                <span className="drop-formats">JPG · PNG · PDF</span>
              </div>
            )}
          </div>

          <ProgressBar progress={progress} label="經典識別中…" />

          {/* Run button */}
          <div className="action-row">
            <button className={`btn-primary ${isLoading ? 'btn-loading' : ''}`}
              onClick={handleRun} disabled={!selectedFile || isLoading}>
              {isLoading ? <><span className="spinner" />辨識中…</> : <><span className="btn-icon">🎯</span>執行經典辨識</>}
            </button>
            {isLoading && <button className="btn-cancel" onClick={() => abortRef.current?.abort()}>✕ 取消</button>}
          </div>

          {error && <div className="error-banner"><span>⚠</span> {error}</div>}
        </>
      )}
    </div>
  )
}

// ─── App Root ─────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <HashRouter>
      <div className="app-shell" style={{ padding: 0 }}>
        <Routes>
          <Route path="/" element={
            <div style={{ padding: '24px', display: 'flex', justifyContent: 'center', width: '100%' }}>
              <UploadPage />
            </div>
          } />
          <Route path="/result" element={<ResultPage />} />
          <Route path="/template" element={<TemplateEditor />} />
          <Route path="/bill-detect" element={<BillDetectPage />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
