import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import * as pdfjsLib from 'pdfjs-dist'

// Point pdfjs at its bundled worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href

const PALETTE = [
  '#38d9a9', '#60a5fa', '#f472b6', '#fb923c',
  '#a78bfa', '#facc15', '#34d399', '#f87171',
]
const ANCHOR_COLOR = '#f59e0b'  // amber – anchor / decision-point regions

// ─────────────────────────────────────────────────────────────────────────────
// Template Editor
//   • Accepts image (JPG/PNG) or PDF (including multi-page)
//   • Lets users drag bounding boxes on each page to define OCR regions
//   • Regions are saved with { label, page, x, y, w, h } in natural-image coords
// ─────────────────────────────────────────────────────────────────────────────
export default function TemplateEditor() {
  const navigate = useNavigate()

  // ── Canvas ────────────────────────────────────────────────────────
  const canvasRef = useRef(null)
  const fileInputRef = useRef(null)
  const drawing = useRef({ active: false, sx: 0, sy: 0, cx: 0, cy: 0 })

  // ── Document state ────────────────────────────────────────────────
  // fileKind: null | 'image' | 'pdf'
  const [fileKind, setFileKind] = useState(null)
  const pdfDocRef = useRef(null)           // pdfjsLib PDF document
  const [totalPages, setTotalPages] = useState(1)
  const [curPage, setCurPage] = useState(1)
  const [pageLoading, setPageLoading] = useState(false)

  // Per-page display info (set when a page finishes rendering)
  // natW / natH are the natural pixel dims of the rendered page
  const pageInfoRef = useRef({ natW: 1, natH: 1, scale: 1 })
  const bgImageRef = useRef(null)   // ← current page background HTMLImageElement
  const [imgLoaded, setImgLoaded] = useState(false)
  const [pageInfo, setPageInfo] = useState({ natW: 1, natH: 1 })

  // ── Regions ───────────────────────────────────────────────────────
  // { label, page (1-indexed, for PDFs), x, y, w, h }  – natural coords
  const [regions, setRegions] = useState([])
  const [editIdx, setEditIdx] = useState(-1)
  const [editValue, setEditValue] = useState('')
  // ── Anchor / decision-point mode ───────────────────────
  const [anchorMode, setAnchorMode] = useState(false)

  // ── Template save ─────────────────────────────────────────────────
  const [templateName, setTemplateName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  // ── Saved-template list ───────────────────────────────────────────
  const [savedList, setSavedList] = useState([])
  const [loadingList, setLoadingList] = useState(false)

  // ─── Canvas draw ──────────────────────────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const scale = pageInfoRef.current.scale

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // ── Always redraw the background image first
    if (bgImageRef.current) {
      ctx.drawImage(bgImageRef.current, 0, 0, canvas.width, canvas.height)
    }
    const visibleRegions = regions.filter(r =>
      fileKind === 'image' ? true : r.page === curPage
    )

    visibleRegions.forEach((r, i) => {
      const globalIdx = regions.indexOf(r)
      const color = r.is_anchor ? ANCHOR_COLOR : PALETTE[globalIdx % PALETTE.length]
      const dx = r.x * scale, dy = r.y * scale
      const dw = r.w * scale, dh = r.h * scale

      ctx.save()
      ctx.fillStyle = color + '28'
      ctx.fillRect(dx, dy, dw, dh)
      ctx.strokeStyle = color
      ctx.lineWidth = r.is_anchor ? 2.5 : 2
      if (r.is_anchor) ctx.setLineDash([6, 3])
      ctx.strokeRect(dx, dy, dw, dh)
      ctx.setLineDash([])

      // Label pill
      const prefix = r.is_anchor ? '🔑 ' : ''
      const labelText = prefix + r.label
      ctx.font = 'bold 12px Inter,sans-serif'
      const tw = ctx.measureText(labelText).width + 10
      ctx.fillStyle = color
      ctx.fillRect(dx, Math.max(0, dy - 20), tw, 20)
      ctx.fillStyle = r.is_anchor ? '#000' : '#000'
      ctx.fillText(labelText, dx + 5, Math.max(14, dy - 4))
      ctx.restore()
    })

    // ── In-progress rect
    const d = drawing.current
    if (d.active) {
      const rx = Math.min(d.sx, d.cx)
      const ry = Math.min(d.sy, d.cy)
      const rw = Math.abs(d.cx - d.sx)
      const rh = Math.abs(d.cy - d.sy)
      ctx.save()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 3])
      ctx.strokeRect(rx, ry, rw, rh)
      ctx.setLineDash([])
      ctx.restore()
    }
  }, [regions, curPage, fileKind])

  useEffect(() => { redraw() }, [redraw])

  // Safety: ensure background + regions are redrawn after the canvas becomes
  // visible.  useLayoutEffect fires synchronously after DOM mutations,
  // so the canvas is guaranteed to be visible when drawImage runs.
  useLayoutEffect(() => {
    if (!imgLoaded || !bgImageRef.current || !canvasRef.current) return
    redraw()
  }, [imgLoaded, redraw])

  // ─── Render a page (image or PDF page) onto the canvas ───────────
  const renderPageToCanvas = useCallback((imgElement, natW, natH) => {
    const MAX_W = Math.min(window.innerWidth * 0.62, 760)
    const scale = natW > MAX_W ? MAX_W / natW : 1
    pageInfoRef.current = { natW, natH, scale }

    const canvas = canvasRef.current
    if (!canvas) return                          // safety – should never happen

    // Resize canvas first (also clears it)
    canvas.width = Math.round(natW * scale)
    canvas.height = Math.round(natH * scale)

    // Store background so redraw() can repaint it on every re-render
    bgImageRef.current = imgElement

    // Draw immediately so the image is visible the same frame we make the
    // canvas wrap visible (via setImgLoaded).  The useLayoutEffect safety
    // net on imgLoaded will do a full redraw() afterward.
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgElement, 0, 0, canvas.width, canvas.height)

    setPageInfo({ natW, natH })
    setImgLoaded(true)
  }, [])


  // ─── Render a single PDF page ─────────────────────────────────────
  const renderPdfPage = useCallback(async (page) => {
    setPageLoading(true)
    try {
      const SCALE = 1.5                    // render at 1.5× for quality
      const viewport = page.getViewport({ scale: SCALE })

      // Off-screen canvas to render the PDF page
      const offCanvas = document.createElement('canvas')
      offCanvas.width = viewport.width
      offCanvas.height = viewport.height
      const offCtx = offCanvas.getContext('2d')

      await page.render({ canvasContext: offCtx, viewport }).promise

      // Convert to HTMLImageElement so downstream code is uniform
      await new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          renderPageToCanvas(img, viewport.width, viewport.height)
          resolve()
        }
        img.onerror = reject
        img.src = offCanvas.toDataURL('image/png')
      })
    } finally {
      setPageLoading(false)
    }
  }, [renderPageToCanvas])

  // ─── Navigate PDF pages ───────────────────────────────────────────
  const goToPage = useCallback(async (pageNum) => {
    if (!pdfDocRef.current) return
    const clamped = Math.max(1, Math.min(pageNum, totalPages))
    setCurPage(clamped)
    const page = await pdfDocRef.current.getPage(clamped)
    await renderPdfPage(page)
  }, [totalPages, renderPdfPage])

  // ─── Handle file drop / select ────────────────────────────────────
  const handleFile = useCallback(async (file) => {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

    setRegions([])
    setImgLoaded(false)

    if (isPdf) {
      setFileKind('pdf')
      setPageLoading(true)
      try {
        const bytes = await file.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
        pdfDocRef.current = pdf
        setTotalPages(pdf.numPages)
        setCurPage(1)
        const page = await pdf.getPage(1)
        await renderPdfPage(page)
      } catch (err) {
        console.error('PDF load error:', err)
        alert('無法載入 PDF：' + err.message)
      } finally {
        setPageLoading(false)
      }
    } else if (file.type.startsWith('image/')) {
      setFileKind('image')
      pdfDocRef.current = null
      setTotalPages(1)
      setCurPage(1)
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => renderPageToCanvas(img, img.naturalWidth, img.naturalHeight)
      img.src = url
    } else {
      alert('請選擇圖片（JPG / PNG）或 PDF 檔案')
    }
  }, [renderPdfPage, renderPageToCanvas])

  // ─── Canvas pointer events ────────────────────────────────────────
  const canvasXY = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onMouseDown = (e) => {
    if (!imgLoaded) return
    const { x, y } = canvasXY(e)
    drawing.current = { active: true, sx: x, sy: y, cx: x, cy: y }
  }

  const onMouseMove = (e) => {
    if (!drawing.current.active) return
    const { x, y } = canvasXY(e)
    drawing.current.cx = x
    drawing.current.cy = y
    redraw()
  }

  const onMouseUp = (e) => {
    if (!drawing.current.active) return
    const { x, y } = canvasXY(e)
    drawing.current.cx = x
    drawing.current.cy = y
    drawing.current.active = false

    const d = drawing.current
    const sc = pageInfoRef.current.scale
    const rx = Math.round(Math.min(d.sx, x) / sc)
    const ry = Math.round(Math.min(d.sy, y) / sc)
    const rw = Math.round(Math.abs(x - d.sx) / sc)
    const rh = Math.round(Math.abs(y - d.sy) / sc)

    if (rw < 6 || rh < 6) { redraw(); return }

    const anchorCount = regions.filter(r => r.is_anchor).length
    const normalCount = regions.filter(r => !r.is_anchor).length
    const label = anchorMode
      ? `判斷點${anchorCount + 1}`
      : `區域${normalCount + 1}`
    const baseRegion = { label, x: rx, y: ry, w: rw, h: rh }
    if (anchorMode) baseRegion.is_anchor = true
    const newRegion = fileKind === 'pdf'
      ? { ...baseRegion, page: curPage }
      : baseRegion
    setRegions(prev => [...prev, newRegion])
  }

  // ─── Label editing ────────────────────────────────────────────────
  const commitLabel = (idx) => {
    setRegions(prev => prev.map((r, i) =>
      i === idx ? { ...r, label: editValue.trim() || r.label } : r
    ))
    setEditIdx(-1); setEditValue('')
  }

  // ─── Save template ────────────────────────────────────────────────
  const handleSave = async () => {
    if (!templateName.trim()) { setSaveMsg('⚠ 請填寫模板名稱'); return }
    if (regions.length === 0) { setSaveMsg('⚠ 請至少框選一個識別區域'); return }

    setSaving(true); setSaveMsg('')
    try {
      const fd = new FormData()
      fd.append('name', templateName.trim())
      fd.append('ref_width', Math.round(pageInfo.natW))
      fd.append('ref_height', Math.round(pageInfo.natH))
      fd.append('regions', JSON.stringify(regions))
      fd.append('file_type', fileKind ?? 'image')

      const res = await fetch('http://127.0.0.1:8000/api/templates', { method: 'POST', body: fd })
      if (!res.ok) throw new Error((await res.json()).detail ?? '儲存失敗')
      setSaveMsg('✓ 模板已儲存！')
      fetchList()
    } catch (err) {
      setSaveMsg('❌ ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // ─── Saved-template list ──────────────────────────────────────────
  const fetchList = async () => {
    setLoadingList(true)
    try {
      const res = await fetch('http://127.0.0.1:8000/api/templates')
      const data = await res.json()
      setSavedList(data)
    } catch { /* backend offline */ }
    finally { setLoadingList(false) }
  }

  useEffect(() => { fetchList() }, [])

  const handleDelete = async (name) => {
    if (!confirm(`確定要刪除模板「${name}」嗎？`)) return
    await fetch(`http://127.0.0.1:8000/api/templates/${encodeURIComponent(name)}`, { method: 'DELETE' })
    fetchList()
  }

  // ─── UI helpers ───────────────────────────────────────────────────
  const currentPageRegions = fileKind === 'pdf'
    ? regions.filter(r => r.page === curPage)
    : regions

  // ═══════════════════════════════════════════════════════════════════
  return (
    <div className="te-shell">

      {/* Header */}
      <div className="te-header">
        <button className="btn-back" onClick={() => navigate('/')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          返回首頁
        </button>
        <div>
          <h1 className="te-title">📐 模板編輯器</h1>
          <p className="te-subtitle">在參考文件上拖曳框選識別區域，儲存後在「經典模式」使用</p>
        </div>
      </div>

      {/* Body */}
      <div className="te-body">

        {/* ── Left: canvas panel ── */}
        <div className="te-canvas-panel">

          {/* Upload placeholder */}
          {!imgLoaded && !pageLoading && (
            <div className="te-upload-placeholder" onClick={() => fileInputRef.current?.click()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p>點擊上傳參考圖片或 PDF</p>
              <span>此文件用於定義識別區域（僅作版型參考）</span>
              <span className="drop-formats" style={{ marginTop: 4 }}>JPG · PNG · PDF</span>
            </div>
          )}

          {/* Loading overlay */}
          {pageLoading && (
            <div className="te-loading">
              <span className="spinner" />
              <span>載入中…</span>
            </div>
          )}

          {/* Canvas – always in DOM; hidden with visibility so canvas ops
              work before the user has uploaded an image */}
          <div
            className="te-canvas-wrap"
            style={{
              visibility: imgLoaded ? 'visible' : 'hidden',
              // Collapse height when hidden so placeholder takes the space
              height: imgLoaded ? 'auto' : 0,
              overflow: imgLoaded ? 'auto' : 'hidden',
            }}
          >
            <canvas
              ref={canvasRef}
              className="te-canvas"
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            />
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden-input"
            onChange={e => handleFile(e.target.files[0])}
          />

          {/* Toolbar */}
          <div className="te-canvas-toolbar">
            <button
              className="btn-back"
              style={{ fontSize: '0.8rem', padding: '6px 14px' }}
              onClick={() => fileInputRef.current?.click()}
            >
              {imgLoaded ? '🔄 更換檔案' : '📂 選擇檔案'}
            </button>

            {/* Anchor mode toggle */}
            {imgLoaded && (
              <button
                className="btn-back"
                style={{
                  fontSize: '0.8rem', padding: '6px 14px',
                  borderColor: anchorMode ? ANCHOR_COLOR : undefined,
                  color: anchorMode ? ANCHOR_COLOR : undefined,
                  background: anchorMode ? 'rgba(245,158,11,0.12)' : undefined,
                }}
                onClick={() => setAnchorMode(v => !v)}
                title="切換為「判斷點」模式：框選的區域將作為自動識別模板的比對依據"
              >
                {anchorMode ? '🔑 判斷點模式 ON' : '📌 切換判斷點模式'}
              </button>
            )}

            {/* PDF page nav */}
            {fileKind === 'pdf' && totalPages > 1 && (
              <div className="te-page-nav">
                <button className="te-page-btn" onClick={() => goToPage(curPage - 1)} disabled={curPage <= 1}>‹</button>
                <span className="te-page-info">第 {curPage} / {totalPages} 頁</span>
                <button className="te-page-btn" onClick={() => goToPage(curPage + 1)} disabled={curPage >= totalPages}>›</button>
              </div>
            )}

            {imgLoaded && (
              <span className="te-img-info">
                {pageInfo.natW} × {pageInfo.natH} px
                {fileKind === 'pdf' && ` · ${regions.length} 個區域（共 ${totalPages} 頁）`}
                {fileKind === 'image' && ` · ${regions.length} 個區域`}
              </span>
            )}
          </div>
        </div>

        {/* ── Right: sidebar ── */}
        <div className="te-sidebar">

          {/* Template name */}
          <div className="te-section">
            <label className="te-label">模板名稱 *</label>
            <input
              className="te-input"
              placeholder="例如：支票 / 保單封面"
              value={templateName}
              onChange={e => setTemplateName(e.target.value)}
            />
          </div>

          {/* Save */}
          <div className="te-section">
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner" />儲存中…</> : <>💾 儲存模板</>}
            </button>
            {saveMsg && (
              <p className={`te-save-msg ${saveMsg.startsWith('✓') ? 'ok' : 'err'}`}>{saveMsg}</p>
            )}
          </div>


          {/* Region list for current page */}
          <div className="te-section" style={{ flex: 1, minHeight: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label className="te-label">
                {fileKind === 'pdf' ? `第 ${curPage} 頁的區域 (${currentPageRegions.length})` : `識別區域 (${regions.length})`}
              </label>
              {regions.length > 0 && (
                <button className="te-link-btn" onClick={() =>
                  fileKind === 'pdf'
                    ? setRegions(p => p.filter(r => r.page !== curPage))
                    : setRegions([])
                }>
                  {fileKind === 'pdf' ? '清除本頁' : '清除全部'}
                </button>
              )}
            </div>

            {currentPageRegions.length === 0 && (
              <p className="te-empty-hint">
                {imgLoaded ? '在左側圖片上拖曳滑鼠框選區域' : '請先上傳參考文件'}
              </p>
            )}

            <div className="te-region-list">
              {regions.map((r, i) => {
                // For PDF mode, only show this page's regions in the list
                if (fileKind === 'pdf' && r.page !== curPage) return null
                const dotColor = r.is_anchor ? ANCHOR_COLOR : PALETTE[i % PALETTE.length]
                return (
                  <div key={i} className="te-region-item" style={r.is_anchor ? { borderLeft: `2px solid ${ANCHOR_COLOR}`, paddingLeft: 6 } : {}}>
                    <span className="te-region-dot" style={{ background: dotColor }} />
                    {r.is_anchor && <span style={{ fontSize: '0.7rem', color: ANCHOR_COLOR, marginRight: 2 }}>🔑</span>}

                    {editIdx === i ? (
                      <input
                        className="te-region-input"
                        value={editValue}
                        autoFocus
                        onChange={e => setEditValue(e.target.value)}
                        onBlur={() => commitLabel(i)}
                        onKeyDown={e => e.key === 'Enter' && commitLabel(i)}
                      />
                    ) : (
                      <span
                        className="te-region-label"
                        onClick={() => { setEditIdx(i); setEditValue(r.label) }}
                        title="點擊重新命名"
                        style={r.is_anchor ? { color: ANCHOR_COLOR } : {}}
                      >
                        {r.label}
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                          style={{ width: 11, marginLeft: 4, opacity: 0.45 }}>
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </span>
                    )}

                    <span className="te-region-size">{r.w}×{r.h}</span>
                    <button className="te-del-btn" onClick={() => setRegions(p => p.filter((_, ii) => ii !== i))}>✕</button>
                  </div>
                )
              })}
            </div>

            {/* All-pages summary for PDF */}
            {fileKind === 'pdf' && regions.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary className="te-link-btn" style={{ cursor: 'pointer', listStyle: 'none' }}>
                  全部頁面區域總覽 ({regions.length})
                </summary>
                <div className="te-region-list" style={{ marginTop: 8 }}>
                  {regions.map((r, i) => (
                    <div key={i} className="te-region-item" style={{ opacity: r.page === curPage ? 1 : 0.55 }}>
                      <span className="te-region-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="te-region-size" style={{ marginRight: 4 }}>P{r.page}</span>
                      <span className="te-region-label" style={{ cursor: 'default' }}>{r.label}</span>
                      <span className="te-region-size">{r.w}×{r.h}</span>
                      <button className="te-del-btn" onClick={() => setRegions(p => p.filter((_, ii) => ii !== i))}>✕</button>
                    </div>
                  ))}
                </div>
                {totalPages > 1 && (
                  <button className="te-link-btn" style={{ marginTop: 6, color: 'var(--red)' }}
                    onClick={() => setRegions([])}>
                    清除全部頁面的區域
                  </button>
                )}
              </details>
            )}
          </div>



          {/* Saved list */}
          <div className="te-section">
            <label className="te-label">已儲存的模板</label>
            {loadingList && <p className="te-empty-hint">載入中…</p>}
            {!loadingList && savedList.length === 0 && <p className="te-empty-hint">尚無模板</p>}
            <div className="te-saved-list">
              {savedList.map(t => (
                <div key={t.name} className="te-saved-item">
                  <div>
                    <span className="te-saved-name">{t.name}</span>
                    <span className="te-saved-meta">{t.region_count} 個區域</span>
                  </div>
                  <button className="te-del-btn" onClick={() => handleDelete(t.name)}>🗑</button>
                </div>
              ))}
            </div>
          </div>

          {/* Instructions */}
          <div className="te-instructions">
            <p className="te-label" style={{ marginBottom: 6 }}>使用說明</p>
            <ol>
              <li>上傳圖片或 PDF 作為版型參考</li>
              <li>PDF 可翻頁，在各頁上分別框選</li>
              <li>在圖片上 <strong>拖曳</strong> 框選識別區域</li>
              <li>點擊區域名稱可重新命名</li>
              <li>點擊「<strong>📌 切換判斷點模式</strong>」後框選的區域會成為<strong style={{color:ANCHOR_COLOR}}>🔑 判斷點</strong>（橘色），用於「自動識別」模式的文件比對</li>
              <li>填入模板名稱後點擊儲存</li>
              <li>在首頁「<strong>🎯 經典模式</strong>」或「<strong>🔍 自動識別</strong>」使用</li>
            </ol>
          </div>

        </div>
      </div>
    </div>
  )
}
