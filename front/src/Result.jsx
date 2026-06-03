import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { FORMAT_MODES, CLASSIC_MODEL_PROVIDERS } from './constants'

// ─── Structured JSON Renderer ────────────────────────────────────────────────
export function StructuredResult({ jsonText }) {
  let data = null
  try {
    let cleaned = jsonText.trim()
    if (cleaned.startsWith('```')) {
      const first = cleaned.indexOf('\n')
      if (first !== -1) cleaned = cleaned.slice(first + 1)
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trimEnd()
    }
    data = JSON.parse(cleaned)
  } catch {
    return (
      <div className="json-fallback">
        <p className="json-parse-warn">⚠ 無法解析 JSON，顯示原始回應：</p>
        <pre className="json-raw">{jsonText}</pre>
      </div>
    )
  }

  return (
    <div className="structured-result">
      {data.document_info && (
        <div className="doc-info-card">
          <h3 className="doc-type">
            {data.document_info.type || data.document_info.document_type || '未知表單'}
          </h3>
          {(data.document_info.company || data.document_info.primary_entity_name ||
            data.document_info.hospital_name) && (
              <span className="doc-company">
                {data.document_info.company ||
                  data.document_info.primary_entity_name ||
                  data.document_info.hospital_name}
              </span>
            )}
        </div>
      )}

      {data.blocks?.map((block, bi) => (
        <div key={bi} className="struct-block">
          <div className="struct-block-header">
            {block.block_id && <span className="struct-block-id">{block.block_id}</span>}
            <span className="struct-block-title">{block.block_title}</span>
          </div>
          <div className="struct-block-body">
            {block.elements?.map((el, ei) => {
              if (el.type === 'field') {
                return (
                  <div key={ei} className="struct-field">
                    <span className="struct-field-label">{el.label}</span>
                    <span className="struct-field-value">{el.value ?? '—'}</span>
                  </div>
                )
              }
              if (el.type === 'text_block') {
                return (
                  <div key={ei} className="struct-text-block">
                    <p>{el.content}</p>
                  </div>
                )
              }
              if (el.type === 'checkbox' || el.type === 'checkbox_group') {
                return (
                  <div key={ei} className="struct-checkbox-group">
                    <span className="struct-cb-label">{el.label}</span>
                    <div className="struct-cb-options">
                      {el.options?.map((opt, oi) => (
                        <span key={oi} className={`struct-cb-chip ${opt.selected ? 'selected' : ''}`}>
                          <span className="cb-indicator">{opt.selected ? '☑' : '☐'}</span>
                          {opt.text}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              }
              if (el.type === 'record_list') {
                return (
                  <div key={ei} className="struct-record-list">
                    {el.label && <p className="struct-table-label">{el.label}</p>}
                    <div className="record-list-items">
                      {el.records?.map((rec, ri) => (
                        <div key={ri} className="record-item">
                          <div className="record-item-index">#{ri + 1}</div>
                          <div className="record-item-fields">
                            {Object.entries(rec).map(([k, v], ki) => (
                              <div key={ki} className="struct-field">
                                <span className="struct-field-label">{k}</span>
                                <span className="struct-field-value">{v ?? '—'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              }
              if (el.type === 'table') {
                return (
                  <div key={ei} className="struct-table-wrap">
                    {el.label && <p className="struct-table-label">{el.label}</p>}
                    <table className="struct-table">
                      <thead>
                        <tr>
                          {el.headers?.map((h, hi) => <th key={hi}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {el.rows?.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((cell, ci) => <td key={ci}>{cell.value ?? '—'}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
              return null
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Result Page with History ────────────────────────────────────────────────
export default function ResultPage() {
  const navigate = useNavigate()
  const location = useLocation()

  const [currentResult, setCurrentResult] = useState(location.state?.result || null)
  const [historyLogs, setHistoryLogs] = useState([])
  const [activeLog, setActiveLog] = useState(null)

  const [copied, setCopied] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [expandedDates, setExpandedDates] = useState({})
  // 控制是否顯示歷史側邊欄
  const [showHistory, setShowHistory] = useState(!location.state?.result)

  // 分群歷史紀錄
  const groupedLogs = historyLogs.reduce((acc, log) => {
    const rawDate = log.timestamp ? log.timestamp.substring(0, 8) : '未分類';
    const dateKey = rawDate.length === 8 ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : rawDate;
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(log);
    return acc;
  }, {});
  const sortedDates = Object.keys(groupedLogs).sort((a, b) => b.localeCompare(a));

  const toggleDateGroup = (date) => {
    setExpandedDates(prev => ({ ...prev, [date]: prev[date] === undefined ? false : !prev[date] }))
  }

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch('http://127.0.0.1:8000/api/logs')
        const data = await res.json()
        setHistoryLogs(data)
      } catch (err) {
        console.error('Failed to load logs', err)
      }
    }
    fetchLogs()
  }, [])

  const handleLogClick = async (filename) => {
    try {
      const res = await fetch(`http://127.0.0.1:8000/api/logs/${filename}`)
      const data = await res.json()

      setCurrentResult({
        json_text: data.json_text || '{}',
        mode: data.mode || 'unknown',
        filename: data.filename || filename,
        previewUrl: null, // we don't have the original image stored for logs
      })
      setActiveLog(filename)
      setShowHistory(false) // 點擊記錄後自動隱藏清單
    } catch (err) {
      console.error('Failed to load log detail', err)
    }
  }

  const exportToCsv = () => {
    if (!currentResult) return
    let jsonText = currentResult.json_text || ''
    let cleaned = jsonText.trim()
    if (cleaned.startsWith('```')) {
      const first = cleaned.indexOf('\n')
      if (first !== -1) cleaned = cleaned.slice(first + 1)
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trimEnd()
    }

    let data
    try { data = JSON.parse(cleaned) } catch { return }

    const esc = (v) => {
      const s = v == null ? '' : String(v)
      return s.includes(',') || s.includes('\n') || s.includes('"')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s
    }

    const rows = [['區塊', '欄位', '值']]

    for (const block of (data.blocks || [])) {
      const blockTitle = block.block_title || block.block_id || ''
      for (const el of (block.elements || [])) {
        if (el.type === 'field') {
          rows.push([esc(blockTitle), esc(el.label), esc(el.value)])
        } else if (el.type === 'checkbox' || el.type === 'checkbox_group') {
          const selected = (el.options || [])
            .filter(o => o.selected)
            .map(o => o.text)
            .join('；')
          rows.push([esc(blockTitle), esc(el.label), esc(selected)])
        } else if (el.type === 'text_block') {
          rows.push([esc(blockTitle), esc(el.label || '文字段落'), esc(el.content)])
        } else if (el.type === 'record_list') {
          ; (el.records || []).forEach((rec, ri) => {
            Object.entries(rec).forEach(([k, v]) => {
              rows.push([esc(blockTitle), esc(`${el.label || ''}[${ri + 1}] ${k}`), esc(v)])
            })
          })
        } else if (el.type === 'table') {
          const headers = el.headers || []
            ; (el.rows || []).forEach((row, ri) => {
              row.forEach((cell, ci) => {
                rows.push([esc(blockTitle), esc(`${el.label || ''}[${ri + 1}] ${headers[ci] || ci}`), esc(cell.value)])
              })
            })
        }
      }
    }

    const csv = '\uFEFF' + rows.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const base = currentResult.filename?.replace(/\.[^.]+$/, '') || 'ocr_result'
    a.href = url
    a.download = `${base}_${currentResult.mode}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopy = () => {
    if (!currentResult) return
    navigator.clipboard.writeText(currentResult.json_text || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`result-page-container ${showHistory ? 'show-history' : 'hide-history'}`}>
      {/* Left Sidebar for History */}
      {showHistory && (
        <div className="history-sidebar">
          <div className="history-header">
            <span className="history-title">歷史紀錄</span>
            {currentResult ? (
              <button className="btn-back" onClick={() => setShowHistory(false)} style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                收起列表 ✕
              </button>
            ) : (
              <button className="btn-back" onClick={() => navigate('/')} style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                ⟵ 新增辨識
              </button>
            )}
          </div>
          <div className="history-list">
            {historyLogs.length === 0 && <p style={{ color: 'var(--text-dim)', textAlign: 'center', marginTop: '20px', fontSize: '0.9rem' }}>暫無歷史記錄</p>}
            {sortedDates.map(dateKey => {
              const isExpanded = expandedDates[dateKey] === true; // 預設關閉
              return (
                <div key={dateKey} className="history-date-group" style={{ marginBottom: '12px' }}>
                <div 
                  className="history-date-header" 
                  onClick={() => toggleDateGroup(dateKey)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 10px', cursor: 'pointer', background: 'var(--bg-card)',
                    borderRadius: '8px', fontSize: '0.85rem', fontWeight: 'bold',
                    color: 'var(--text-color)', border: '1px solid var(--border-color)',
                    marginBottom: '6px'
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" fill="none" style={{ color: 'var(--primary-color)' }}>
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    {dateKey}
                    <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem', fontWeight: 'normal' }}>
                      ({groupedLogs[dateKey].length})
                    </span>
                  </span>
                  <span style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', fontSize: '0.7rem' }}>
                    ▼
                  </span>
                </div>

                {isExpanded && (
                  <div className="history-group-items" style={{ paddingLeft: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {groupedLogs[dateKey].map(log => {
                      const ts = log.timestamp ? log.timestamp.substring(9, 11) + ':' + log.timestamp.substring(11, 13) : ''
                      return (
                        <div
                          key={log.filename}
                          className={`history-item ${activeLog === log.filename ? 'active' : ''}`}
                          onClick={() => handleLogClick(log.filename)}
                        >
                          <div className="history-item-top">
                            <span className="history-item-filename" title={log.origin_name}>{log.origin_name}</span>
                            <span className="history-item-mode">{FORMAT_MODES.find(m => m.key === log.mode)?.label || log.mode}</span>
                          </div>
                          <div className="history-item-time">{ts}</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      )}

      {/* Main Area */}
      <div className={`result-main-area ${!showHistory ? 'full-width' : ''}`}>
        {!currentResult ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            </svg>
            <p>請從左側選擇一份歷史紀錄，或點擊左上角返回上傳新圖片 / PDF</p>
          </div>
        ) : (
          <div className="page result-page" style={{ margin: 0, width: '100%', maxWidth: !showHistory ? '1200px' : '100%', marginInline: 'auto' }}>
            <div className="result-topbar">
              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn-back" onClick={() => navigate('/')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 12H5M12 5l-7 7 7 7" />
                  </svg>
                  首頁
                </button>
                {!showHistory && (
                  <button className="btn-secondary" onClick={() => setShowHistory(true)} style={{ padding: '6px 12px', fontSize: '0.9rem', borderRadius: '8px', cursor: 'pointer', backgroundColor: 'var(--bg-card)', color: 'var(--text-color)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    查看歷史
                  </button>
                )}
              </div>
              
              <div className="result-filename">{currentResult.filename}</div>
              <button className="btn-copy" onClick={handleCopy}>
                {copied ? '✓ 已複製' : '複製 JSON'}
              </button>
            </div>

            <div className="result-layout">
              {/* Left: image preview or Placeholder */}
              <div className="result-image-panel">
                <p className="panel-label">原始圖片</p>
                {currentResult.previewUrl ? (
                  <img
                    src={currentResult.previewUrl}
                    alt="source"
                    className="result-img result-img-zoomable"
                    onClick={() => setLightboxOpen(true)}
                    title="點擊放大"
                  />
                ) : (
                  <div className="pdf-result-placeholder">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    </svg>
                    <p className="pdf-result-name">{currentResult.filename}</p>
                    <p className="pdf-result-hint">歷史紀錄無預覽圖 / 多頁文件</p>
                  </div>
                )}
              </div>

              {/* Right: AI-generated Struct */}
              <div className="result-text-panel">
                <div className="panel-header">
                  <p className="panel-label">AI 分析結果</p>
                  <div className="panel-actions">
                    <span className="badge-mode">
                      {FORMAT_MODES.find(m => m.key === currentResult.mode)?.label || currentResult.mode}
                    </span>
                    {currentResult.optimized && <span className="badge-optimized">⚡ 優化</span>}
                    {currentResult.provider && (
                      <span className="badge-ai">{CLASSIC_MODEL_PROVIDERS.find(p => p.key === currentResult.provider)?.badge ?? currentResult.provider}</span>
                    )}
                  </div>
                </div>

                <div className="result-content">
                  {!currentResult.json_text || !currentResult.json_text.trim() ? (
                    <div className="no-result">
                      <span>🔍</span>
                      <p>未偵測到任何內容</p>
                    </div>
                  ) : (
                    <StructuredResult jsonText={currentResult.json_text} />
                  )}
                </div>
              </div>
            </div>

            {/* Lightbox */}
            {lightboxOpen && currentResult.previewUrl && (
              <div className="lightbox-overlay" onClick={() => setLightboxOpen(false)}>
                <button className="lightbox-close" onClick={() => setLightboxOpen(false)}>✕</button>
                <img
                  src={currentResult.previewUrl}
                  alt="放大預覽"
                  className="lightbox-img"
                  onClick={e => e.stopPropagation()}
                />
              </div>
            )}

            {/* CSV export FAB */}
            {currentResult.json_text && (
              <button className="btn-csv-fab" onClick={exportToCsv} title="匯出分析結果為 CSV">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                匯出 CSV
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
