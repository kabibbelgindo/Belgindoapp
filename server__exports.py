"""Ekspor Excel (.xlsx) dan PDF untuk dokumen operasional."""
from __future__ import annotations

from datetime import datetime
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.properties import PageSetupProperties
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, A5, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .core import APP_NAME, display_date, fmt_qty, money_text, m3_text, now_iso

NAVY = "123B63"
TEAL = "0F766E"
LIGHT = "EEF4F8"
GRID = "CBD5E1"


def _stamp_label() -> str:
    return datetime.now().strftime("%d-%m-%Y %H:%M")


def xlsx_bytes(title: str, subtitle: str, headers: list[str], rows: list[list],
               formats: dict[int, str] | None = None, totals: list | None = None,
               sheet_title: str = "Laporan") -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    safe_title = "".join(ch for ch in str(sheet_title or "Laporan") if ch not in r"[]:*?/\\")[:31] or "Laporan"
    sheet.title = safe_title
    formats = formats or {}
    last_col = max(1, len(headers))
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_col)
    cell = sheet.cell(row=1, column=1, value=f"{APP_NAME} — {title}")
    cell.font = Font(name="Calibri", size=15, bold=True, color=NAVY)
    cell.alignment = Alignment(vertical="center")
    sheet.row_dimensions[1].height = 25
    sheet.merge_cells(start_row=2, start_column=1, end_row=2, end_column=last_col)
    subtitle_cell = sheet.cell(row=2, column=1, value=subtitle or f"Dibuat {_stamp_label()}")
    subtitle_cell.font = Font(name="Calibri", size=9, color="526477")
    subtitle_cell.alignment = Alignment(vertical="center")

    header_row = 4
    header_fill = PatternFill("solid", fgColor=NAVY)
    thin = Side(style="thin", color=GRID)
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    for index, header in enumerate(headers, start=1):
        cell = sheet.cell(row=header_row, column=index, value=header)
        cell.font = Font(name="Calibri", size=9, bold=True, color="FFFFFF")
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = border
    sheet.row_dimensions[header_row].height = 26

    for row_index, values in enumerate(rows, start=header_row + 1):
        for column_index, value in enumerate(values, start=1):
            cell = sheet.cell(row=row_index, column=column_index, value=value)
            cell.font = Font(name="Calibri", size=9)
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=isinstance(value, str) and len(str(value)) > 28)
            if (column_index - 1) in formats:
                cell.number_format = formats[column_index - 1]
    if totals:
        total_row = header_row + len(rows) + 1
        for column_index, value in enumerate(totals, start=1):
            cell = sheet.cell(row=total_row, column=column_index, value=value)
            cell.font = Font(name="Calibri", size=9, bold=True, color=NAVY)
            cell.fill = PatternFill("solid", fgColor=LIGHT)
            cell.border = Border(top=Side(style="medium", color=NAVY), bottom=thin, left=thin, right=thin)
            if (column_index - 1) in formats:
                cell.number_format = formats[column_index - 1]
    for index, header in enumerate(headers, start=1):
        values = [str(header)]
        for row in rows:
            if index - 1 < len(row) and row[index - 1] is not None:
                values.append(str(row[index - 1]))
        width = max(len(value) for value in values) + 3
        sheet.column_dimensions[get_column_letter(index)].width = max(10, min(42, width))
    sheet.freeze_panes = f"A{header_row + 1}"
    sheet.auto_filter.ref = f"A{header_row}:{get_column_letter(last_col)}{header_row + len(rows)}"
    sheet.sheet_view.showGridLines = False
    sheet.page_setup.orientation = "landscape"
    sheet.page_setup.fitToWidth = 1
    sheet.page_setup.fitToHeight = 0
    sheet.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
    sheet.print_title_rows = f"{header_row}:{header_row}"
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="BrTitle", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=13,
        leading=16, textColor=colors.HexColor("#123B63"), alignment=TA_LEFT,
    ))
    styles.add(ParagraphStyle(
        name="BrSub", parent=styles["Normal"], fontName="Helvetica", fontSize=7.5,
        leading=10, textColor=colors.HexColor("#4B5563"),
    ))
    styles.add(ParagraphStyle(
        name="BrSmall", parent=styles["Normal"], fontName="Helvetica", fontSize=7,
        leading=9, textColor=colors.HexColor("#374151"),
    ))
    styles.add(ParagraphStyle(
        name="BrSmallRight", parent=styles["Normal"], fontName="Helvetica", fontSize=7,
        leading=9, alignment=TA_RIGHT, textColor=colors.HexColor("#374151"),
    ))
    styles.add(ParagraphStyle(
        name="BrCell", parent=styles["Normal"], fontName="Helvetica", fontSize=6.5,
        leading=8, textColor=colors.HexColor("#111827"),
    ))
    styles.add(ParagraphStyle(
        name="BrCellRight", parent=styles["Normal"], fontName="Helvetica", fontSize=6.5,
        leading=8, alignment=TA_RIGHT, textColor=colors.HexColor("#111827"),
    ))
    return styles


def _pdf_table(headers, rows, widths, align_right=None, font_size=6.5) -> Table:
    styles = _styles()
    align_right = set(align_right or [])
    data = [[Paragraph(str(header), styles["BrSmall"]) for header in headers]]
    for row in rows:
        line = []
        for index, value in enumerate(row):
            style = styles["BrCellRight"] if index in align_right else styles["BrCell"]
            line.append(Paragraph(str(value if value is not None else ""), style))
        data.append(line)
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DCE7F0")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#123B63")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#B9C7D6")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7FAFC")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    return table


def tally_pdf(db, tally_id: int) -> bytes:
    from .documents import get_tally
    header = get_tally(db, int(tally_id))
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=(210 * mm, 99 * mm),
        leftMargin=7 * mm, rightMargin=7 * mm, topMargin=6 * mm, bottomMargin=5 * mm,
        title=f"Slip Tally {header['tally_number']}", author=APP_NAME,
    )
    styles = _styles()
    story = []
    story.append(Paragraph(f"{APP_NAME} — SLIP TALLY", styles["BrTitle"]))
    story.append(Paragraph(
        f"No. {header['tally_number']} · Dibuat {str(header.get('created_at') or '')[:16].replace('T', ' ')} · "
        f"Status {header.get('status')}",
        styles["BrSub"],
    ))
    story.append(Spacer(1, 3))
    info = [
        [Paragraph(f"<b>Penjual</b> {header.get('seller_name') or '-'}", styles["BrSmall"]),
         Paragraph(f"<b>Rit</b> {header.get('rit_number_display') or '-'} · {display_date(header.get('rit_date'))}", styles["BrSmall"]),
         Paragraph(f"<b>Nota</b> {header.get('note') or '-'}", styles["BrSmall"]),
         Paragraph(f"<b>Surat Jalan</b> {header.get('delivery_number') or '-'}", styles["BrSmall"])],
    ]
    info_table = Table(info, colWidths=[52 * mm, 50 * mm, 42 * mm, 46 * mm])
    info_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F1F5F9")),
        ("BOX", (0, 0), (-1, -1), 0.3, colors.HexColor("#CBD5E1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 4))
    rows = []
    for item in header.get("items", []):
        rows.append([
            f"{item.get('code') or ''} {item.get('name') or ''}",
            item.get("size_display") or "-",
            item.get("kind") or "-",
            fmt_qty(item.get("qty")),
            m3_text(item.get("volume")),
            money_text(item.get("price_m3")),
            money_text(item.get("amount")),
        ])
    rows.append(["TOTAL", "", "", fmt_qty(header.get("total_qty")), m3_text(header.get("total_volume")), "", money_text(header.get("total_amount"))])
    table = _pdf_table(
        ["Barang", "Ukuran T×L×P", "Jenis", "Qty", "M³", "Harga/m³", "Jumlah"],
        rows, [54 * mm, 30 * mm, 15 * mm, 14 * mm, 20 * mm, 29 * mm, 28 * mm],
        align_right={3, 4, 5, 6},
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, len(rows)), (-1, len(rows)), colors.HexColor("#E7F0EA")),
        ("FONTNAME", (0, len(rows)), (-1, len(rows)), "Helvetica-Bold"),
    ]))
    story.append(table)
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        f"Diperiksa oleh: <b>{header.get('signature') or '-'}</b> &nbsp;&nbsp;|&nbsp;&nbsp; "
        f"Total qty: <b>{fmt_qty(header.get('total_qty'))}</b> &nbsp;&nbsp;|&nbsp;&nbsp; "
        f"Total volume: <b>{m3_text(header.get('total_volume'))} m³</b>",
        styles["BrSmall"],
    ))
    doc.build(story)
    return buffer.getvalue()


def recap_pdf(db, recap_id: int) -> bytes:
    from .documents import get_recap
    header = get_recap(db, int(recap_id))
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A5, leftMargin=11 * mm, rightMargin=11 * mm,
        topMargin=11 * mm, bottomMargin=10 * mm,
        title=f"Rekap {header['recap_number']}", author=APP_NAME,
    )
    styles = _styles()
    story = [
        Paragraph(f"{APP_NAME} — REKAP PEMBAYARAN", styles["BrTitle"]),
        Paragraph(f"{header['recap_number']} · {display_date(str(header.get('created_at') or '')[:10])}", styles["BrSub"]),
        Spacer(1, 6),
    ]
    info = [
        [Paragraph(f"<b>Penjual</b><br/>{header.get('seller_name') or '-'}", styles["BrSmall"]),
         Paragraph(f"<b>Rit / Nota</b><br/>{header.get('rit_number_display') or '-'} / {header.get('note') or '-'}", styles["BrSmall"])],
        [Paragraph(f"<b>Total qty</b><br/>{fmt_qty(header.get('total_qty'))}", styles["BrSmall"]),
         Paragraph(f"<b>Total volume</b><br/>{m3_text(header.get('total_volume'))} m³", styles["BrSmall"])],
    ]
    info_table = Table(info, colWidths=[85 * mm, 80 * mm])
    info_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F1F5F9")),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#E2E8F0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(info_table)
    story.append(Spacer(1, 8))
    rows = []
    for item in header.get("items", []):
        rows.append([
            f"{item.get('code') or ''} {item.get('name') or ''}",
            item.get("size_display") or "-",
            fmt_qty(item.get("qty")),
            m3_text(item.get("volume")),
            money_text(item.get("price")),
            money_text(item.get("amount")),
        ])
    table = _pdf_table(
        ["Barang", "Ukuran T×L×P", "Qty", "M³", "Harga/m³", "Jumlah"],
        rows, [42 * mm, 27 * mm, 14 * mm, 18 * mm, 28 * mm, 36 * mm],
        align_right={2, 3, 4, 5},
    )
    story.append(table)
    story.append(Spacer(1, 7))
    story.append(Paragraph(
        f"<b>TOTAL PEMBAYARAN: {money_text(header.get('total_amount'))}</b>",
        ParagraphStyle("total", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=11,
                       alignment=TA_RIGHT, textColor=colors.HexColor("#0F766E")),
    ))
    story.append(Spacer(1, 14))
    story.append(Paragraph(
        f"Status: {header.get('status')} &nbsp;&nbsp; Dibuat oleh: {header.get('username') or '-'}",
        styles["BrSmall"],
    ))
    story.append(Spacer(1, 10))
    signature = Table([
        [Paragraph("Mengetahui,<br/><br/><br/><br/>________________________", styles["BrSmall"]),
         Paragraph("Penerima,<br/><br/><br/><br/>________________________", styles["BrSmall"])]
    ], colWidths=[85 * mm, 80 * mm])
    signature.setStyle(TableStyle([("ALIGN", (0, 0), (-1, -1), "CENTER"), ("VALIGN", (0, 0), (-1, -1), "BOTTOM")]))
    story.append(signature)
    doc.build(story)
    return buffer.getvalue()


def opname_pdf(db, opname_id: int, mode: str = "count") -> bytes:
    from .opname import get_session
    session = get_session(db, int(opname_id))
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=landscape(A4), leftMargin=10 * mm, rightMargin=10 * mm,
        topMargin=10 * mm, bottomMargin=10 * mm,
        title=f"Stok Opname #{opname_id}", author=APP_NAME,
    )
    styles = _styles()
    title = "LEMBAR HITUNG STOK OPNAME" if mode == "count" else "HASIL STOK OPNAME"
    story = [
        Paragraph(f"{APP_NAME} — {title}", styles["BrTitle"]),
        Paragraph(
            f"Periode {session['period_start_display']} s.d. {session['period_end_display']} · "
            f"Status {session['label_status']} · Dibuat {str(session.get('created_at') or '')[:16].replace('T', ' ')}",
            styles["BrSub"],
        ),
        Spacer(1, 5),
    ]
    summary = session.get("summary", {})
    summary_table = Table([[
        Paragraph(f"<b>Item</b><br/>{summary.get('items', 0)}", styles["BrSmall"]),
        Paragraph(f"<b>Sudah dihitung</b><br/>{summary.get('counted', 0)}", styles["BrSmall"]),
        Paragraph(f"<b>Belum dihitung</b><br/>{summary.get('uncounted', 0)}", styles["BrSmall"]),
        Paragraph(f"<b>Selisih lebih</b><br/>{fmt_qty(summary.get('plus_qty', 0))}", styles["BrSmall"]),
        Paragraph(f"<b>Selisih kurang</b><br/>{fmt_qty(summary.get('minus_qty', 0))}", styles["BrSmall"]),
    ]], colWidths=[55 * mm, 55 * mm, 55 * mm, 55 * mm, 55 * mm])
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F1F5F9")),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#E2E8F0")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(summary_table)
    story.append(Spacer(1, 7))
    rows = []
    for index, item in enumerate(session.get("items", []), start=1):
        rows.append([
            index, f"{item.get('code') or ''} {item.get('name') or ''}",
            item.get("size_display") or "-", item.get("location") or "-",
            fmt_qty(item.get("system_qty")),
            "" if mode == "count" else ("—" if item.get("physical_qty") is None else fmt_qty(item.get("physical_qty"))),
            "" if mode == "count" else ("—" if item.get("diff") is None else fmt_qty(item.get("diff"))),
            item.get("reason") or "",
            item.get("note") or "",
        ])
    table = _pdf_table(
        ["No", "Barang", "Ukuran", "Lokasi", "Stok Sistem", "Stok Fisik", "Selisih", "Alasan", "Catatan"],
        rows, [8 * mm, 63 * mm, 27 * mm, 30 * mm, 22 * mm, 22 * mm, 20 * mm, 45 * mm, 40 * mm],
        align_right={0, 4, 5, 6},
    )
    story.append(table)
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "Diperiksa oleh: ____________________ &nbsp;&nbsp;&nbsp;&nbsp; "
        "Disahkan oleh: ____________________ &nbsp;&nbsp;&nbsp;&nbsp; Tanggal: ____________",
        styles["BrSmall"],
    ))
    doc.build(story)
    return buffer.getvalue()
