export const MODEL_PROVIDERS = [
  { key: 'gemini', label: 'Gemini 3.0', badge: 'Gemini · Google' },
  { key: 'gemma', label: 'gemma', badge: 'gemma · Ollama' },
  { key: 'glm-ocr', label: 'Mitac_1.5', badge: 'GLM-OCR · Local' },
]
export const CLASSIC_MODEL_PROVIDERS = [
  ...MODEL_PROVIDERS,
  { key: 'pure-glm', label: '純 GLM-OCR', badge: 'GLM-OCR ‧ Local' },
]
export const FORMAT_MODES = [
  { key: 'business_card', label: '名片模式', desc: '找出名片重要資訊' },
  { key: 'general', label: '醫療病歷、保單', desc: '結構化 JSON 病歷與保單關鍵欄位' },
  { key: 'handwriting', label: '手寫辨識', desc: '專精手寫文字、簽名、填寫表單辨識' },
  { key: 'complex_form', label: '批單及存摺', desc: '跨行交錯表格、批單等文件' },
  { key: 'credit_card_auth', label: '信用卡授權書', desc: '結構化萃取表單欄位為 JSON' },
  { key: 'cheque', label: '支票辨識', desc: '批量支票萃取：票號、金額、發票人、銀行帳號' },
  { key: 'car_and_insurance', label: '車輛與保險', desc: '牌照登記書、保險要保書關鍵欄位萃取' },
  { key: 'id_and_license', label: '證件與駕照', desc: '身分證、駕照、行照辨識與欄位萃取' },
]
