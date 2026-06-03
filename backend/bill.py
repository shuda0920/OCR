import io
import json
import logging
import re
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from PIL import Image

logger = logging.getLogger(__name__)
router = APIRouter()

BILL_PROMPTS_DIR = Path(__file__).parent / "prompts" / "bill_prompt"
BILL_PROMPTS_DIR.mkdir(parents=True, exist_ok=True)


def _load_text(filename: str) -> str:
    """讀取 bill_prompt 目錄下指定檔案"""
    path = BILL_PROMPTS_DIR / filename
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def _load_bill_type_list() -> str:
    """讀取 bill.txt，回傳完整內容（每行一個類型描述）"""
    return _load_text("bill.txt")


def _load_construct_template() -> str:
    """讀取 construct.txt，回傳 JSON 格式模板"""
    return _load_text("construct.txt")


# ── 共用：圖片前處理 ─────────────────────────────────────────────────────────
async def _preprocess_image(image: UploadFile, provider: str):
    """讀取上傳圖片並轉為 base64，回傳 (b64_img, fname)"""
    from main import (
        prepare_image,
        prepare_image_for_glm,
        pil_to_base64,
        pdf_to_pil_images
    )

    file_bytes = await image.read()
    fname = (image.filename or "").lower()
    is_pdf = image.content_type == "application/pdf" or fname.endswith(".pdf")

    try:
        if is_pdf:
            pages = pdf_to_pil_images(file_bytes)
            if not pages:
                raise HTTPException(status_code=400, detail="PDF 沒有可辨識的頁面")
            target_img = prepare_image(pages[0])
        else:
            target_img = prepare_image(
                Image.open(io.BytesIO(file_bytes)).convert("RGB")
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"無法開啟檔案: {exc}")

    if provider in ("glm-ocr", "pure-glm"):
        target_img_for_ai = prepare_image_for_glm(target_img)
    else:
        target_img_for_ai = target_img

    b64_img = pil_to_base64(target_img_for_ai)
    return b64_img, fname


# ── Stage 1：類型偵測 ─────────────────────────────────────────────────────────
@router.post("/api/bill-detect/stage1")
async def bill_detect_stage1(
    image: UploadFile = File(...),
    provider: str = Form("gemma"),
    use_template: bool = Form(True),
):
    """第一階段：分析圖片，從 bill.txt 描述中找出最符合的單據類型"""
    from main import call_vision

    b64_img, fname = await _preprocess_image(image, provider)

    if not use_template:
        logger.info("[Stage 1] use_template=False，直接回傳通用類型")
        return {"detected_type": "通用智能提取", "use_template": False}

    bill_type_list = _load_bill_type_list()
    if not bill_type_list:
        raise HTTPException(
            status_code=400,
            detail="找不到 bill.txt，請確認 backend/prompts/bill_prompt/bill.txt 存在。"
        )

    logger.info("[Stage 1] 開始分析圖片類型...")
    stage1_prompt = (
        "你是一個單據 / 發票類型分類助手。\n"
        "請仔細觀察這張圖片，然後從以下列出的單據類型中，選出 **最符合** 這張圖片的一個類型。\n\n"
        "【可選類型列表】\n"
        f"{bill_type_list}\n\n"
        "請只回傳你判斷出的類型名稱（如：電子發票證明聯、信用卡簽單 等），"
        "不要包含任何其他說明文字、編號或符號。"
    )

    try:
        result = await call_vision(b64_img, stage1_prompt, provider)
        detected_type = result.strip().strip('"').strip().splitlines()[0].strip()
    except Exception as e:
        logger.error(f"[Stage 1] 分類失敗: {e}")
        raise HTTPException(status_code=500, detail=f"第一階段分類失敗: {e}")

    logger.info(f"[Stage 1] 判斷結果：{detected_type}")
    return {"detected_type": detected_type, "use_template": True}


# ── Stage 2：資料提取 ─────────────────────────────────────────────────────────
@router.post("/api/bill-detect/stage2")
async def bill_detect_stage2(
    image: UploadFile = File(...),
    provider: str = Form("gemma"),
    detected_type: str = Form(...),
    use_template: bool = Form(True),
):
    """第二階段：根據已知類型，用 construct.txt 格式提取發票資料"""
    from main import call_vision, extract_html, save_log

    b64_img, fname = await _preprocess_image(image, provider)

    construct_template = _load_construct_template()
    if not construct_template:
        raise HTTPException(
            status_code=400,
            detail="找不到 construct.txt，請確認 backend/prompts/bill_prompt/construct.txt 存在。"
        )

    logger.info(f"[Stage 2] 開始提取資料，類型為：{detected_type}")

    if use_template:
        stage2_prompt = (
            f"你是一個單據資訊提取助手。\n"
            f"這張圖片的單據類型已判斷為：**{detected_type}**\n\n"
            f"請根據上述單據類型，仔細閱讀圖片中的所有資訊，"
            f"並依照以下 JSON 格式模板提取對應欄位的值。\n"
            f"【輸出 JSON 格式模板】\n"
            f"{construct_template}\n\n"
            f"請務必只輸出純 JSON，不要包含任何說明文字、markdown 標記或程式碼區塊。"
        )
    else:
        stage2_prompt = (
            f"你是一個單據資訊提取助手。\n"
            f"請仔細觀察這張圖片，提取所有有價值的資訊，"
            f"並依照以下 JSON 格式模板填入對應欄位。\n"
            f"若某欄位在圖片中不存在或無法辨識，請將值設為 null。\n\n"
            f"【輸出 JSON 格式模板】\n"
            f"{construct_template}\n\n"
            f"請務必只輸出純 JSON，不要包含任何說明文字、markdown 標記或程式碼區塊。"
        )

    try:
        stage2_result = await call_vision(b64_img, stage2_prompt, provider)
        cleaned_json = extract_html(stage2_result).strip()
    except Exception as e:
        logger.error(f"[Stage 2] 提取失敗: {e}")
        raise HTTPException(status_code=500, detail=f"第二階段資料提取失敗: {e}")

    try:
        construct_data = json.loads(cleaned_json)
    except Exception:
        logger.warning("[Stage 2] JSON 解析失敗，回傳 raw_text")
        construct_data = {"raw_text": cleaned_json}

    final_data = {
        "detected_type": detected_type,
        "use_template": use_template,
        "blocks": _construct_to_blocks(construct_data, detected_type),
        "construct_json": construct_data,
    }
    final_data["json_text"] = json.dumps(final_data, ensure_ascii=False)

    log_name = save_log(
        f"bill_detect_{detected_type}", fname, provider, final_data["json_text"]
    )
    final_data["log_name"] = log_name
    return final_data


# ── 輔助：將 construct_data 轉換為前端 blocks 格式 ──────────────────────────────
def _construct_to_blocks(data: dict, detected_type: str) -> list:
    """將 construct.txt 解析出的 dict 轉換為 ResultPage 可渲染的 blocks 結構"""
    if not isinstance(data, dict):
        return [{"block_id": "raw", "block_title": "原始結果",
                 "elements": [{"type": "field", "label": "內容", "value": str(data)}]}]

    blocks = []

    # 若 JSON 解析失敗（raw_text）
    if "raw_text" in data and len(data) == 1:
        blocks.append({
            "block_id": "raw",
            "block_title": "原始辨識結果",
            "elements": [{"type": "field", "label": "內容", "value": data["raw_text"]}]
        })
        return blocks

    # 定義各 section 的中文顯示標題
    section_labels = {
        "document_metadata": "文件資訊",
        "issuer_info":        "發行方資訊",
        "transaction_details": "交易明細",
        "financial_summary":  "財務摘要",
        "payment_info":       "付款資訊",
        "line_items":         "品項清單",
        "visual_features":    "視覺特徵",
    }

    def flatten_to_elements(obj, prefix=""):
        """遞迴展平 dict/list 為 elements"""
        elements = []
        if isinstance(obj, dict):
            for k, v in obj.items():
                label = f"{prefix}.{k}" if prefix else k
                if isinstance(v, list):
                    if v and isinstance(v[0], dict):
                        elements.append({"type": "record_list", "label": label, "records": v})
                    else:
                        elements.append({"type": "field", "label": label,
                                         "value": ", ".join(str(i) for i in v) if v else "—"})
                elif isinstance(v, dict):
                    elements.extend(flatten_to_elements(v, prefix=label))
                else:
                    elements.append({"type": "field", "label": label,
                                     "value": str(v) if v is not None else "—"})
        return elements

    for section_key, section_label in section_labels.items():
        if section_key not in data:
            continue
        section_val = data[section_key]

        if section_key == "line_items" and isinstance(section_val, list):
            blocks.append({
                "block_id": section_key,
                "block_title": section_label,
                "elements": [{"type": "record_list", "label": "", "records": section_val}]
            })
        elif isinstance(section_val, dict):
            blocks.append({
                "block_id": section_key,
                "block_title": section_label,
                "elements": flatten_to_elements(section_val)
            })
        else:
            blocks.append({
                "block_id": section_key,
                "block_title": section_label,
                "elements": [{"type": "field", "label": section_key,
                               "value": str(section_val) if section_val is not None else "—"}]
            })

    # 如果 AI 回傳了 construct.txt 以外的 key，也一併顯示
    extra_keys = [k for k in data if k not in section_labels]
    if extra_keys:
        extra_elements = []
        for k in extra_keys:
            extra_elements.extend(flatten_to_elements({k: data[k]}))
        if extra_elements:
            blocks.append({
                "block_id": "extra",
                "block_title": "其他資訊",
                "elements": extra_elements
            })

    return blocks
