import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// ─── Inline Bill Result Renderer ─────────────────────────────────────────────
function BillResultTable({ data }) {
    if (!data || typeof data !== 'object') return null

    const sectionOrder = [
        ['document_metadata', '📋 文件資訊'],
        ['issuer_info',       '🏪 發行方資訊'],
        ['transaction_details','🔢 交易明細'],
        ['financial_summary', '💰 財務摘要'],
        ['payment_info',      '💳 付款資訊'],
        ['line_items',        '🛒 品項清單'],
        ['visual_features',   '🖼 視覺特徵'],
    ]

    const renderValue = (v) => {
        if (v === null || v === undefined) return <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>—</span>
        if (Array.isArray(v)) {
            if (v.length === 0) return <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>—</span>
            if (typeof v[0] === 'object') return null // handled as record_list
            return v.join(', ')
        }
        if (typeof v === 'object') return JSON.stringify(v)
        return String(v)
    }

    const renderDict = (obj, depth = 0) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
        return Object.entries(obj).map(([k, v]) => {
            if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') return null
            if (typeof v === 'object' && !Array.isArray(v) && v !== null) {
                return (
                    <div key={k} style={{ marginBottom: '4px' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 0 2px', borderBottom: '1px dashed var(--border-color)', marginBottom: '4px' }}>{k}</div>
                        <div style={{ paddingLeft: '12px' }}>{renderDict(v, depth + 1)}</div>
                    </div>
                )
            }
            return (
                <div key={k} className="struct-field" style={{ padding: '6px 10px' }}>
                    <span className="struct-field-label" style={{ fontSize: depth > 0 ? '0.8rem' : '0.85rem', color: 'var(--text-muted)' }}>{k}</span>
                    <span className="struct-field-value" style={{ fontSize: '0.9rem' }}>{renderValue(v)}</span>
                </div>
            )
        })
    }

    const renderSection = (key, label) => {
        if (!(key in data)) return null
        const val = data[key]

        if (key === 'line_items' && Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
            const headers = Object.keys(val[0])
            return (
                <div key={key} className="struct-block" style={{ marginBottom: '16px' }}>
                    <div className="struct-block-header">
                        <span className="struct-block-title">{label}</span>
                        <span style={{ marginLeft: '8px', fontSize: '0.75rem', color: 'var(--text-dim)' }}>{val.length} 筆</span>
                    </div>
                    <div className="struct-block-body" style={{ padding: '12px' }}>
                        <div style={{ overflowX: 'auto' }}>
                            <table className="struct-table" style={{ width: '100%', fontSize: '0.85rem' }}>
                                <thead>
                                    <tr>{headers.map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 10px', background: 'rgba(251,191,36,0.08)', fontWeight: 600, fontSize: '0.78rem', textTransform: 'uppercase' }}>{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {val.map((row, ri) => (
                                        <tr key={ri}>
                                            {headers.map(h => (
                                                <td key={h} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-color)', verticalAlign: 'top' }}>
                                                    {row[h] !== null && row[h] !== undefined ? String(row[h]) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )
        }

        if (Array.isArray(val)) {
            return (
                <div key={key} className="struct-block" style={{ marginBottom: '16px' }}>
                    <div className="struct-block-header"><span className="struct-block-title">{label}</span></div>
                    <div className="struct-block-body" style={{ padding: '12px' }}>
                        <div className="struct-field">
                            <span className="struct-field-value">{val.length > 0 ? val.join(', ') : '—'}</span>
                        </div>
                    </div>
                </div>
            )
        }

        return (
            <div key={key} className="struct-block" style={{ marginBottom: '16px' }}>
                <div className="struct-block-header"><span className="struct-block-title">{label}</span></div>
                <div className="struct-block-body" style={{ padding: '4px 0' }}>
                    {typeof val === 'object' ? renderDict(val) : (
                        <div className="struct-field" style={{ padding: '6px 10px' }}>
                            <span className="struct-field-value">{String(val)}</span>
                        </div>
                    )}
                </div>
            </div>
        )
    }

    return (
        <div className="structured-result">
            {sectionOrder.map(([key, label]) => renderSection(key, label))}
        </div>
    )
}

// ─── Shared progress-bar hook (mirrors App.jsx) ───────────────────────────────
function useProgress(isLoading) {
    const [progress, setProgress] = useState(0)
    const timerRef = useRef(null)
    useEffect(() => {
        if (isLoading) {
            setProgress(0)
            const start = Date.now()
            timerRef.current = setInterval(() => {
                const elapsed = (Date.now() - start) / 1000
                const p = 88 * (1 - Math.exp(-elapsed / 40))
                setProgress(p)
            }, 300)
        } else {
            clearInterval(timerRef.current)
            setProgress(v => (v > 0 ? 100 : 0))
            const t = setTimeout(() => setProgress(0), 600)
            return () => clearTimeout(t)
        }
        return () => clearInterval(timerRef.current)
    }, [isLoading])
    return progress
}

function ProgressBar({ progress, label }) {
    if (progress <= 0) return null
    const pct = Math.min(100, Math.round(progress))
    return (
        <div className="ocr-progress-wrap">
            <div className="ocr-progress-header">
                <span className="ocr-progress-label">{label || '辨識中…'}</span>
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

// ─── Invoice Detect Page ──────────────────────────────────────────────────────
export default function BillDetectPage() {
    const navigate = useNavigate()

    // input mode: 'upload' | 'camera'
    const [inputMode, setInputMode] = useState('upload')

    // file / capture state
    const [selectedFile, setSelectedFile] = useState(null)
    const [previewUrl, setPreviewUrl] = useState(null)
    const [isDragging, setIsDragging] = useState(false)
    const [useTemplate, setUseTemplate] = useState(true)

    // camera
    const [cameraActive, setCameraActive] = useState(false)
    const [cameraError, setCameraError] = useState(null)
    const [facingMode, setFacingMode] = useState('environment') // 'user' | 'environment'
    const videoRef = useRef(null)
    const streamRef = useRef(null)
    const canvasRef = useRef(null)

    // OCR
    const [isLoading, setIsLoading] = useState(false)
    const [stage, setStage] = useState(null)         // null | 'stage1' | 'stage2' | 'done'
    const [detectedType, setDetectedType] = useState(null) // 第一階段偵測結果
    const [constructResult, setConstructResult] = useState(null) // 第二階段 construct JSON
    const [error, setError] = useState(null)
    const [result, setResult] = useState(null)
    const abortRef = useRef(null)
    const inputRef = useRef(null)
    const progress = useProgress(isLoading)

    // ── Stop camera when unmounting or switching away ────────────────────────
    useEffect(() => {
        return () => stopCamera()
    }, [])

    const stopCamera = () => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop())
            streamRef.current = null
        }
        setCameraActive(false)
    }

    const startCamera = async (facing = facingMode) => {
        stopCamera()
        setCameraError(null)
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false,
            })
            streamRef.current = stream
            if (videoRef.current) {
                videoRef.current.srcObject = stream
                await videoRef.current.play()
            }
            setCameraActive(true)
        } catch (err) {
            setCameraError('無法存取相機：' + (err.message || err.name))
        }
    }

    const flipCamera = async () => {
        const next = facingMode === 'environment' ? 'user' : 'environment'
        setFacingMode(next)
        await startCamera(next)
    }

    const capturePhoto = () => {
        const video = videoRef.current
        const canvas = canvasRef.current
        if (!video || !canvas) return
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d').drawImage(video, 0, 0)
        canvas.toBlob(blob => {
            if (!blob) return
            const file = new File([blob], `capture_${Date.now()}.jpg`, { type: 'image/jpeg' })
            setSelectedFile(file)
            setPreviewUrl(URL.createObjectURL(blob))
            setResult(null)
            setError(null)
            stopCamera()
            setInputMode('upload') // show preview in upload area
        }, 'image/jpeg', 0.92)
    }

    // ── File selection ────────────────────────────────────────────────────────
    const handleFile = (file) => {
        if (!file) return
        const isImg = file.type.startsWith('image/')
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
        if (!isImg && !isPdf) {
            setError('請選擇圖片（JPG / PNG）或 PDF 檔案')
            return
        }
        setSelectedFile(file)
        setPreviewUrl(isImg ? URL.createObjectURL(file) : null)
        setError(null)
        setResult(null)
    }

    const handleDrop = useCallback((e) => {
        e.preventDefault()
        setIsDragging(false)
        handleFile(e.dataTransfer.files[0])
    }, [])

    // ── OCR submit ────────────────────────────────────────────────────────────
    const handleSubmit = async () => {
        if (!selectedFile) return
        setIsLoading(true)
        setStage('stage1')
        setDetectedType(null)
        setConstructResult(null)
        setError(null)
        setResult(null)
        const controller = new AbortController()
        abortRef.current = controller

        try {
            // ── 第一階段：偵測單據類型 ─────────────────────────────────────
            const fd1 = new FormData()
            fd1.append('image', selectedFile)
            fd1.append('use_template', String(useTemplate))

            const res1 = await fetch('http://127.0.0.1:8000/api/bill-detect/stage1', {
                method: 'POST',
                body: fd1,
                signal: controller.signal,
            })
            if (!res1.ok) {
                const e = await res1.json()
                throw new Error(e.detail || '第一階段偵測失敗')
            }
            const data1 = await res1.json()
            const dtype = data1.detected_type || '未知'

            // ✅ 第一階段真正完成，立即更新顯示
            setDetectedType(dtype)
            setStage('stage2')

            // ── 第二階段：提取資料 ─────────────────────────────────────────
            const fd2 = new FormData()
            fd2.append('image', selectedFile)
            fd2.append('use_template', String(useTemplate))
            fd2.append('detected_type', dtype)

            const res2 = await fetch('http://127.0.0.1:8000/api/bill-detect/stage2', {
                method: 'POST',
                body: fd2,
                signal: controller.signal,
            })
            if (!res2.ok) {
                const e = await res2.json()
                throw new Error(e.detail || '第二階段提取失敗')
            }
            const data2 = await res2.json()

            setConstructResult(data2.construct_json || null)
            setResult(data2)
            setStage('done')
        } catch (err) {
            if (err.name !== 'AbortError') {
                setError(err.message || '發生錯誤')
            }
            setStage(null)
        } finally {
            setIsLoading(false)
            abortRef.current = null
        }
    }

    const handleDownloadCsv = () => {
        if (!result || !result.json_text) return
        try {
            const clean = result.json_text.replace(/```json|```/g, '').trim()
            const parsed = JSON.parse(clean)
            
            let csvContent = '\uFEFF' // BOM for UTF-8 Excel support
            const rows = []
            
            // Helper function to flatten object slightly
            const flattenObj = (obj) => {
                const flat = {}
                Object.keys(obj).forEach(key => {
                    if (key === 'items') return
                    if (typeof obj[key] === 'object' && obj[key] !== null) {
                        Object.keys(obj[key]).forEach(subKey => {
                            flat[`${key}_${subKey}`] = obj[key][subKey]
                        })
                    } else {
                        flat[key] = obj[key]
                    }
                })
                return flat
            }

            if (parsed.items && Array.isArray(parsed.items) && parsed.items.length > 0) {
                const flatHeader = flattenObj(parsed)
                const headerKeys = Object.keys(flatHeader)
                const itemKeys = Object.keys(parsed.items[0])
                
                rows.push([...headerKeys, ...itemKeys].join(','))
                
                parsed.items.forEach(item => {
                    const rowData = []
                    headerKeys.forEach(k => {
                        const val = flatHeader[k]
                        rowData.push(`"${String(val || '').replace(/"/g, '""')}"`)
                    })
                    itemKeys.forEach(k => {
                        const val = item[k]
                        rowData.push(`"${String(val || '').replace(/"/g, '""')}"`)
                    })
                    rows.push(rowData.join(','))
                })
            } else {
                const flatObj = flattenObj(parsed)
                rows.push('Key,Value')
                Object.entries(flatObj).forEach(([k, v]) => {
                    rows.push(`"${k}","${String(v || '').replace(/"/g, '""')}"`)
                })
            }
            
            csvContent += rows.join('\n')
            
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement("a")
            link.setAttribute("href", url)
            link.setAttribute("download", `bill_export_${Date.now()}.csv`)
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
        } catch (err) {
            console.error(err)
            alert('CSV 轉換失敗，請確認辨識結果格式。')
        }
    }

    // ── Tab switch handlers ───────────────────────────────────────────────────
    const switchToUpload = () => {
        stopCamera()
        setInputMode('upload')
    }

    const switchToCamera = () => {
        setInputMode('camera')
        startCamera()
    }

    return (
        <div className="page bill-detect-page">
            {/* ── Header ────────────────────────────────────────── */}
            <header className="app-header">
                <div className="logo-icon" style={{ background: 'rgba(251,191,36,0.12)', borderColor: 'rgba(251,191,36,0.35)', color: '#fbbf24' }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <rect x="3" y="3" width="18" height="18" rx="3" />
                        <path d="M7 8h10M7 12h6M7 16h4" />
                        <path d="M17 14l1.5 1.5L21 13" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </div>
                <div>
                    <h1 className="app-title" style={{ background: 'linear-gradient(135deg,#fff 30%,#fbbf24)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
                        發票識別
                    </h1>
                    <p className="app-sub">上傳發票圖片 / PDF，或直接拍照，AI 自動解析金額與品項</p>
                </div>
            </header>

            {/* ── Back button ───────────────────────────────────── */}
            <div className="home-nav-row">
                <button onClick={() => navigate('/')} className="btn-back" style={{ padding: '6px 12px', fontSize: '0.83rem' }}>
                    ← 返回主頁
                </button>
            </div>

            {/* ── Input mode tabs ──────────────────────────────── */}
            <div className="bill-mode-tabs">
                <button
                    className={`bill-mode-tab ${inputMode === 'upload' ? 'active' : ''}`}
                    onClick={switchToUpload}
                >
                    <span className="bill-tab-icon">📁</span>
                    上傳檔案
                </button>
                <button
                    className={`bill-mode-tab ${inputMode === 'camera' ? 'active' : ''}`}
                    onClick={switchToCamera}
                >
                    <span className="bill-tab-icon">📷</span>
                    拍照上傳
                </button>
            </div>

            {/* ── Upload Mode ───────────────────────────────────── */}
            {inputMode === 'upload' && (
                <div
                    className={`drop-zone${isDragging ? ' dragging' : ''}${previewUrl || (selectedFile && !previewUrl) ? ' has-preview' : ''}`}
                    onDrop={handleDrop}
                    onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                    onDragLeave={() => setIsDragging(false)}
                    onClick={() => !selectedFile && inputRef.current?.click()}
                >
                    <input
                        ref={inputRef}
                        type="file"
                        accept="image/*,application/pdf"
                        className="hidden-input"
                        onChange={e => handleFile(e.target.files[0])}
                    />

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
                            <div className="drop-icon" style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24' }}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                                    <polyline points="17 8 12 3 7 8" />
                                    <line x1="12" y1="3" x2="12" y2="15" />
                                </svg>
                            </div>
                            <p className="drop-text">拖曳發票圖片或 PDF 到這裡</p>
                            <p className="drop-sub">或點擊此處選擇檔案</p>
                            <span className="drop-formats">JPG · PNG · PDF</span>
                        </div>
                    )}
                </div>
            )}

            {/* ── Camera Mode ───────────────────────────────────── */}
            {inputMode === 'camera' && (
                <div className="bill-camera-wrap">
                    {cameraError ? (
                        <div className="bill-camera-error">
                            <span>⚠️</span>
                            <p>{cameraError}</p>
                            <button className="btn-change" onClick={() => startCamera()}>重試</button>
                        </div>
                    ) : (
                        <>
                            <div className="bill-camera-viewport">
                                <video ref={videoRef} className="bill-camera-video" playsInline muted autoPlay />
                                {/* Guide overlay */}
                                <div className="bill-camera-guide">
                                    <div className="bill-camera-guide-rect" />
                                    <p className="bill-camera-guide-hint">對準發票後點擊拍照</p>
                                </div>
                                {/* Controls overlay */}
                                <div className="bill-camera-controls">
                                    <button className="bill-cam-btn bill-cam-flip" onClick={flipCamera} title="翻轉鏡頭">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M1 4v6h6" /><path d="M23 20v-6h-6" />
                                            <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
                                        </svg>
                                    </button>
                                    <button className="bill-cam-btn bill-cam-capture" onClick={capturePhoto}>
                                        <span className="bill-cam-shutter" />
                                    </button>
                                    <button className="bill-cam-btn bill-cam-cancel" onClick={switchToUpload} title="取消">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                            <canvas ref={canvasRef} style={{ display: 'none' }} />
                        </>
                    )}
                </div>
            )}

            {/* ── Progress ─────────────────────────────────────── */}
            <ProgressBar progress={progress} label="發票識別中…" />

            {/* ── Options ────────────────────────────────────── */}
            {inputMode === 'upload' && (
                <div className="bill-options" style={{ margin: '12px 0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                        <input 
                            type="checkbox" 
                            checked={useTemplate} 
                            onChange={(e) => setUseTemplate(e.target.checked)} 
                            style={{ width: '16px', height: '16px', accentColor: '#fbbf24' }}
                        />
                        使用模板精準比對 (若關閉則由 AI 自由提取有價值資訊)
                    </label>
                </div>
            )}

            {/* ── Action buttons ────────────────────────────────── */}
            {inputMode === 'upload' && (
                <div className="action-row">
                    <button
                        className={`btn-primary${isLoading ? ' btn-loading' : ''}`}
                        style={!isLoading ? { background: 'linear-gradient(135deg,#fbbf24,#f59e0b)', boxShadow: '0 8px 24px rgba(251,191,36,0.3)', color: '#1a1000' } : {}}
                        onClick={handleSubmit}
                        disabled={!selectedFile || isLoading}
                    >
                        {isLoading
                            ? <><span className="spinner" />識別中…</>
                            : <><span className="btn-icon">🧾</span>開始識別發票</>}
                    </button>
                    {isLoading && (
                        <button className="btn-cancel" onClick={() => abortRef.current?.abort()}>✕ 取消</button>
                    )}
                </div>
            )}

            {error && (
                <div className="error-banner"><span>⚠</span> {error}</div>
            )}

            {/* ── Stage indicator ───────────────────────────────────── */}
            {(isLoading || stage === 'done') && (
                <div style={{ margin: '12px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {/* Stage 1 badge */}
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '10px 16px',
                        borderRadius: '10px',
                        background: detectedType ? 'rgba(34,197,94,0.08)' : 'rgba(251,191,36,0.06)',
                        border: `1px solid ${detectedType ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.2)'}`,
                    }}>
                        {detectedType
                            ? <span style={{ fontSize: '1rem' }}>✅</span>
                            : <span className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px', flexShrink: 0 }} />}
                        <div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '2px' }}>第一階段｜格式偵測</div>
                            <div style={{ fontSize: '0.92rem', fontWeight: 600, color: detectedType ? '#22c55e' : '#fbbf24' }}>
                                {detectedType ? `偵測格式：${detectedType}` : '正在分析單據類型…'}
                            </div>
                        </div>
                    </div>

                    {/* Stage 2 badge */}
                    {(stage === 'stage2' || stage === 'done') && (
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: '10px',
                            padding: '10px 16px',
                            borderRadius: '10px',
                            background: stage === 'done' ? 'rgba(34,197,94,0.08)' : 'rgba(251,191,36,0.06)',
                            border: `1px solid ${stage === 'done' ? 'rgba(34,197,94,0.25)' : 'rgba(251,191,36,0.2)'}`,
                        }}>
                            {stage === 'done'
                                ? <span style={{ fontSize: '1rem' }}>✅</span>
                                : <span className="spinner" style={{ width: '14px', height: '14px', borderWidth: '2px', flexShrink: 0 }} />}
                            <div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '2px' }}>第二階段｜資料提取</div>
                                <div style={{ fontSize: '0.92rem', fontWeight: 600, color: stage === 'done' ? '#22c55e' : '#fbbf24' }}>
                                    {stage === 'done' ? '資料提取完成' : '正在提取發票資訊…'}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Inline Result Table ───────────────────────────────── */}
            {stage === 'done' && constructResult && (
                <div style={{ marginTop: '24px' }}>
                    {/* Header */}
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        marginBottom: '16px', paddingBottom: '10px',
                        borderBottom: '1px solid var(--border-color)'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '1.15rem' }}>🧾</span>
                            <div>
                                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-color)' }}>發票識別結果</div>
                                <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>格式：{detectedType}</div>
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(JSON.stringify(constructResult, null, 2))
                                }}
                                style={{
                                    padding: '6px 12px', fontSize: '0.8rem', cursor: 'pointer',
                                    borderRadius: '8px', border: '1px solid var(--border-color)',
                                    background: 'var(--bg-card)', color: 'var(--text-color)'
                                }}
                            >
                                複製 JSON
                            </button>
                            <button
                                onClick={() => navigate('/result', {
                                    state: {
                                        result: {
                                            json_text: result?.json_text || null,
                                            mode: `發票識別 (${detectedType})`,
                                            optimized: false,
                                            provider: 'gemma',
                                            filename: selectedFile?.name,
                                            previewUrl: previewUrl,
                                        }
                                    }
                                })}
                                style={{
                                    padding: '6px 12px', fontSize: '0.8rem', cursor: 'pointer',
                                    borderRadius: '8px', border: 'none',
                                    background: 'linear-gradient(135deg,#fbbf24,#f59e0b)',
                                    color: '#1a1000', fontWeight: 600
                                }}
                            >
                                查看完整報告 →
                            </button>
                        </div>
                    </div>

                    <BillResultTable data={constructResult} />
                </div>
            )}
        </div>
    )
}
