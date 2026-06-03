"""
opencv.py – Template-based region extraction helpers.

A "template" is a saved set of named bounding-box regions:
    { label, page?, x, y, w, h }
- page: 1-indexed PDF page number. Omitted (or None) for image templates.
- x, y, w, h: in natural pixels of the reference document page.

When a new image/PDF is processed in Classic Mode the regions are scaled
proportionally and cropped. OpenCV is used when available (PIL fallback).
"""

import io
import json
from pathlib import Path
from typing import List, Dict, Any, Optional

from PIL import Image

import logging
import fitz

from fastapi import APIRouter, UploadFile, File, Form, HTTPException

logger = logging.getLogger(__name__)

router = APIRouter()

try:
    import cv2
    import numpy as np
    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False

# ── Storage ──────────────────────────────────────────────────────────────────

TEMPLATES_DIR = Path(__file__).parent / "templates"
TEMPLATES_DIR.mkdir(exist_ok=True)


def _template_path(name: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "_-" else "_" for c in name)
    return TEMPLATES_DIR / f"{safe}.json"


# ── CRUD ─────────────────────────────────────────────────────────────────────

def save_template(
    name: str,
    regions: List[Dict[str, Any]],
    ref_width: int,
    ref_height: int,
    file_type: str = "image",
) -> str:
    """Persist a template to disk and return its path."""
    data: Dict[str, Any] = {
        "name":       name,
        "file_type":  file_type,   # "image" | "pdf"
        "ref_width":  ref_width,
        "ref_height": ref_height,
        "regions":    regions,
    }
    path = _template_path(name)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def list_templates() -> List[Dict[str, Any]]:
    """Return summary info for every saved template."""
    result = []
    for path in sorted(TEMPLATES_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            result.append({
                "name":         data.get("name", path.stem),
                "file_type":    data.get("file_type", "image"),
                "ref_width":    data.get("ref_width"),
                "ref_height":   data.get("ref_height"),
                "region_count": len(data.get("regions", [])),
                "regions":      data.get("regions", []),
            })
        except Exception:
            pass
    return result


def load_template(name: str) -> Dict[str, Any]:
    path = _template_path(name)
    if not path.exists():
        raise FileNotFoundError(f"Template '{name}' not found")
    return json.loads(path.read_text(encoding="utf-8"))


def delete_template(name: str) -> bool:
    path = _template_path(name)
    if path.exists():
        path.unlink()
        return True
    return False


# ── Region extraction ─────────────────────────────────────────────────────────

def _crop_one(
    pil_img: Image.Image,
    region: Dict[str, Any],
    scale_x: float,
    scale_y: float,
) -> Image.Image:
    """Crop a single region dict from pil_img (already scaled)."""
    img_w, img_h = pil_img.size

    x = max(0, min(int(region["x"] * scale_x), img_w - 1))
    y = max(0, min(int(region["y"] * scale_y), img_h - 1))
    w = max(1, min(int(region["w"] * scale_x), img_w - x))
    h = max(1, min(int(region["h"] * scale_y), img_h - y))

    if _HAS_CV2:
        np_img     = np.array(pil_img.convert("RGB"))
        cropped_np = np_img[y:y + h, x:x + w]
        return Image.fromarray(cropped_np)
    else:
        return pil_img.crop((x, y, x + w, y + h))


def crop_regions(
    pil_img: Image.Image,
    template: Dict[str, Any],
) -> List[tuple]:
    """
    Crop ALL regions from pil_img regardless of page.
    Used for single-image templates. Returns [(label, PIL.Image), …]
    """
    img_w, img_h = pil_img.size
    ref_w = template.get("ref_width")  or img_w
    ref_h = template.get("ref_height") or img_h
    sx, sy = img_w / ref_w, img_h / ref_h

    results = []
    for r in template.get("regions", []):
        label  = r.get("label", f"region_{len(results) + 1}")
        cropped = _crop_one(pil_img, r, sx, sy)
        results.append((label, cropped))
    return results


def crop_regions_for_page(
    pil_img: Image.Image,
    template: Dict[str, Any],
    page_num: int = 1,
) -> List[tuple]:
    """
    Crop only the regions belonging to *page_num* from pil_img.
    Regions without a 'page' field are treated as page 1.
    Returns [(label, PIL.Image), …]
    """
    img_w, img_h = pil_img.size
    ref_w = template.get("ref_width")  or img_w
    ref_h = template.get("ref_height") or img_h
    sx, sy = img_w / ref_w, img_h / ref_h

    results = []
    for r in template.get("regions", []):
        rpage = r.get("page", 1)
        if rpage != page_num:
            continue
        label   = r.get("label", f"region_{len(results) + 1}")
        cropped = _crop_one(pil_img, r, sx, sy)
        results.append((label, cropped))
    return results


def max_page_in_template(template: Dict[str, Any]) -> int:
    """Return the maximum page number referenced by any region (min 1)."""
    pages = [r.get("page", 1) for r in template.get("regions", [])]
    return max(pages, default=1)


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/api/templates")
async def get_templates():
    """List all saved templates."""
    return list_templates()


@router.post("/api/templates")
async def create_template(
    name: str = Form(...),
    ref_width: int = Form(...),
    ref_height: int = Form(...),
    regions: str = Form(...),
    file_type: str = Form("image"),
):
    """Save a new (or overwrite existing) template."""
    try:
        regions_data = json.loads(regions)
    except Exception:
        raise HTTPException(status_code=400, detail="regions 欄位必須是有效的 JSON")
    if not isinstance(regions_data, list) or len(regions_data) == 0:
        raise HTTPException(status_code=400, detail="請至少定義一個識別區域")
    path = save_template(name, regions_data, ref_width, ref_height, file_type)
    logger.info(f"Template saved: {name!r}  ({len(regions_data)} region(s))  → {path}")
    return {"name": name, "region_count": len(regions_data)}


@router.delete("/api/templates/{name}")
async def remove_template(name: str):
    """Delete a saved template by name."""
    if not delete_template(name):
        raise HTTPException(status_code=404, detail=f"找不到模板: {name}")
    logger.info(f"Template deleted: {name!r}")
    return {"deleted": name}


@router.post("/api/classic-ocr")
async def classic_ocr(
    image: UploadFile = File(...),
    template_name: str = Form(...),
    provider: str = Form("gemma"),
):
    """
    Classic-Mode OCR pipeline:
      1. Load the named template (region definitions).
      2. Detect whether the uploaded file is an image or PDF.
      3. For images: crop all regions and OCR each.
      4. For PDFs: render each page that has template regions, crop, OCR.
    """
    from main import (
        prepare_image,
        prepare_image_for_glm,
        pil_to_base64,
        call_glm_vision,
        call_vision,
        extract_html,
        save_log
    )

    # ── Load template ───────────────────────────────────────────────────────
    try:
        template = load_template(template_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"找不到模板: {template_name!r}")

    if not template.get("regions"):
        raise HTTPException(status_code=400, detail="模板中沒有定義任何識別區域")

    # ── Read uploaded file ──────────────────────────────────────────────────
    file_bytes = await image.read()
    fname      = (image.filename or "").lower()
    is_pdf     = image.content_type == "application/pdf" or fname.endswith(".pdf")

    ocr_prompt = "找出文字與數字，以純內容直接輸出，不要有任何額外解釋與內容"

    async def ocr_region(region_pil: Image.Image) -> str:
        """Run OCR on a single cropped PIL image and return text."""
        if provider in ("glm-ocr", "pure-glm"):
            region_pil = prepare_image_for_glm(region_pil)

        text = await call_vision(pil_to_base64(region_pil), ocr_prompt, provider)
        return extract_html(text).strip()

    region_results = []

    if is_pdf:
        # ── PDF: render each relevant page with PyMuPDF ───────────────────────
        try:
            pdf_doc = fitz.open(stream=file_bytes, filetype="pdf")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"無法閱讀 PDF: {exc}")

        needed_pages = sorted(
            set(r.get("page", 1) for r in template["regions"])
        )
        logger.info(
            f"Classic OCR (PDF): template={template_name!r}  "
            f"pages={needed_pages}  provider={provider}"
        )

        for page_num in needed_pages:
            if page_num < 1 or page_num > pdf_doc.page_count:
                logger.warning(f"  Page {page_num} out of range (doc has {pdf_doc.page_count} pages) – skipped")
                continue

            # Render at 150 DPI (2× scale vs 72 dpi default)
            fitz_page = pdf_doc.load_page(page_num - 1)
            mat       = fitz.Matrix(2.0, 2.0)
            pix       = fitz_page.get_pixmap(matrix=mat, alpha=False)
            pil_page  = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            pil_page  = prepare_image(pil_page)

            cropped = crop_regions_for_page(pil_page, template, page_num)
            logger.info(f"  Page {page_num}: {len(cropped)} region(s)")

            for label, region_pil in cropped:
                try:
                    text = await ocr_region(region_pil)
                except Exception as exc:
                    logger.warning(f"    Region '{label}' failed: {exc}")
                    text = f"[辨識失敗: {exc}]"
                region_label = f"P{page_num} · {label}"
                region_results.append({"label": region_label, "page": page_num, "text": text})
                logger.info(f"    '{label}': {len(text)} chars")

        pdf_doc.close()

    else:
        # ── Single image ─────────────────────────────────────────────────────
        try:
            pil_img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        except Exception:
            raise HTTPException(status_code=400, detail="無法開啟圖片檔案")

        pil_img = prepare_image(pil_img)
        cropped = crop_regions(pil_img, template)
        logger.info(
            f"Classic OCR (image): template={template_name!r}  "
            f"regions={len(cropped)}  provider={provider}"
        )

        for label, region_pil in cropped:
            try:
                text = await ocr_region(region_pil)
            except Exception as exc:
                logger.warning(f"  Region '{label}' failed: {exc}")
                text = f"[辨識失敗: {exc}]"
            region_results.append({"label": label, "text": text})
            logger.info(f"  '{label}': {len(text)} chars")

    if not region_results:
        raise HTTPException(status_code=400, detail="沒有任何區域被辨識，請檢查模板設定")

    # 封裝結果使得前端 StructuredResult 能夠渲染
    formatted_data = {
        "document_info": {
            "type": "傳統模板識別",
            "company": template_name
        },
        "blocks": [
            {
                "block_id": "classic_result",
                "block_title": "自定義框選識別結果",
                "elements": [
                    {
                        "type": "field",
                        "label": r["label"],
                        "value": r["text"].strip()
                    } for r in region_results
                ]
            }
        ]
    }
    
    json_text = json.dumps(formatted_data, ensure_ascii=False)
    
    # 儲存歷史紀錄，讓記錄列表可以展示
    log_name = save_log("classic", fname, template_name, json_text)

    return {
        "regions": region_results, 
        "json_text": json_text,
        "log_name": log_name
    }


# ─────────────────────────────────────────────────────────────────────────────
# Auto-detect OCR endpoint
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/api/auto-detect-ocr")
async def auto_detect_ocr(
    image: UploadFile = File(...),
    provider: str = Form("gemma"),
):
    """
    Auto-detect Mode OCR pipeline:
      1. Load all templates that have at least one anchor region (is_anchor=True).
      2. For each template, crop every anchor region from the uploaded image/PDF.
      3. Ask the AI to read text from those anchor crops ("找出文字與數字").
      4. The template that returns the most non-empty anchor text wins.
      5. Run the full classic OCR pipeline with the winning template.
    Returns the OCR result plus which template was matched.
    """
    from main import (
        prepare_image,
        prepare_image_for_glm,
        pil_to_base64,
        call_vision,
        extract_html,
        save_log,
        pdf_to_pil_images,
    )

    ANCHOR_PROMPT = "識別文字與數字，不用任何多餘解釋，直接回傳識別到的文字"

    # ── Read file ───────────────────────────────────────────────────────────
    file_bytes = await image.read()
    fname      = (image.filename or "").lower()
    is_pdf     = image.content_type == "application/pdf" or fname.endswith(".pdf")

    # Render first page only for anchor matching
    try:
        if is_pdf:
            pages = pdf_to_pil_images(file_bytes)
            if not pages:
                raise HTTPException(status_code=400, detail="PDF 沒有可辨識的頁面")
            match_img = prepare_image(pages[0])
        else:
            match_img = prepare_image(Image.open(io.BytesIO(file_bytes)).convert("RGB"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"無法開啟檔案: {exc}")

    # ── Find templates with anchors ─────────────────────────────────────────
    all_templates = list_templates()
    anchor_templates = []
    for t_meta in all_templates:
        anchors = [r for r in t_meta.get("regions", []) if r.get("is_anchor")]
        if anchors:
            anchor_templates.append((t_meta["name"], anchors, t_meta))

    if not anchor_templates:
        raise HTTPException(
            status_code=400,
            detail="沒有任何模板設定了判斷點（is_anchor）。請先在模板編輯器中框選並標記判斷點區域。"
        )

    logger.info(f"Auto-detect: {len(anchor_templates)} templates with anchors, provider={provider}")

    # ── Score each template by anchor OCR richness ──────────────────────────
    async def ocr_anchor_crop(region_pil) -> str:
        if provider in ("glm-ocr", "pure-glm"):
            region_pil = prepare_image_for_glm(region_pil)
        text = await call_vision(pil_to_base64(region_pil), ANCHOR_PROMPT, provider)
        return extract_html(text).strip()

    best_name  = None
    best_score = -1
    scores     = {}

    for tpl_name, anchors, tpl_meta in anchor_templates:
        # Build a fake template dict for crop_regions
        fake_tpl = {
            "ref_width":  tpl_meta.get("ref_width"),
            "ref_height": tpl_meta.get("ref_height"),
            "regions":    anchors,
        }
        cropped_anchors = crop_regions(match_img, fake_tpl)
        total_chars = 0
        for label, region_pil in cropped_anchors:
            try:
                text = await ocr_anchor_crop(region_pil)
                total_chars += len(text)
                logger.info(f"  [{tpl_name}] anchor '{label}': {len(text)} chars")
            except Exception as exc:
                logger.warning(f"  [{tpl_name}] anchor '{label}' failed: {exc}")
        scores[tpl_name] = total_chars
        if total_chars > best_score:
            best_score = total_chars
            best_name  = tpl_name

    logger.info(f"Auto-detect scores: {scores}  → winner: {best_name!r} ({best_score} chars)")

    if best_name is None or best_score == 0:
        raise HTTPException(
            status_code=422,
            detail="自動比對失敗：所有模板的判斷點均未辨識出文字，請確認圖片品質或判斷點位置。"
        )

    # ── Full OCR with winning template ──────────────────────────────────────
    try:
        template = load_template(best_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"找不到模板: {best_name!r}")

    normal_regions = [r for r in template.get("regions", []) if not r.get("is_anchor")]
    if not normal_regions:
        # If the template only has anchor regions, fall back to using all regions
        normal_regions = template.get("regions", [])

    # Rebuild a template dict with only non-anchor regions for the actual OCR
    ocr_template = {**template, "regions": normal_regions}

    async def ocr_region(region_pil) -> str:
        if provider in ("glm-ocr", "pure-glm"):
            region_pil = prepare_image_for_glm(region_pil)
        text = await call_vision(pil_to_base64(region_pil), ANCHOR_PROMPT, provider)
        return extract_html(text).strip()

    region_results = []

    if is_pdf:
        try:
            pdf_doc = fitz.open(stream=file_bytes, filetype="pdf")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"無法閱讀 PDF: {exc}")

        needed_pages = sorted(set(r.get("page", 1) for r in normal_regions))
        for page_num in needed_pages:
            if page_num < 1 or page_num > pdf_doc.page_count:
                continue
            fitz_page = pdf_doc.load_page(page_num - 1)
            mat       = fitz.Matrix(2.0, 2.0)
            pix       = fitz_page.get_pixmap(matrix=mat, alpha=False)
            pil_page  = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            pil_page  = prepare_image(pil_page)
            cropped   = crop_regions_for_page(pil_page, ocr_template, page_num)
            for label, region_pil in cropped:
                try:
                    text = await ocr_region(region_pil)
                except Exception as exc:
                    text = f"[辨識失敗: {exc}]"
                region_results.append({"label": f"P{page_num} · {label}", "page": page_num, "text": text})
        pdf_doc.close()
    else:
        cropped = crop_regions(match_img, ocr_template)
        for label, region_pil in cropped:
            try:
                text = await ocr_region(region_pil)
            except Exception as exc:
                text = f"[辨識失敗: {exc}]"
            region_results.append({"label": label, "text": text})

    if not region_results:
        raise HTTPException(status_code=400, detail="沒有任何區域被辨識，請檢查模板設定")

    formatted_data = {
        "document_info": {
            "type":    "自動識別",
            "company": best_name,
            "matched_template": best_name,
            "anchor_score": best_score,
            "all_scores": scores,
        },
        "blocks": [
            {
                "block_id":    "auto_result",
                "block_title": f"自動識別結果（模板：{best_name}）",
                "elements": [
                    {"type": "field", "label": r["label"], "value": r["text"]}
                    for r in region_results
                ],
            }
        ],
    }

    json_text = json.dumps(formatted_data, ensure_ascii=False)
    log_name  = save_log("auto_detect", fname, best_name, json_text)

    return {
        "matched_template": best_name,
        "scores":           scores,
        "regions":          region_results,
        "json_text":        json_text,
        "log_name":         log_name,
    }
