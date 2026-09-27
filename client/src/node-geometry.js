export const ENTITY_MIN_WIDTH = 288;
export const AREA_HEADER_HEIGHT = 88;
export const ENTITY_MAX_WIDTH = 288;
export const ENTITY_BASE_HEIGHT = 148;
export const ENTITY_TITLE_LINE_HEIGHT = 24;
export const GROUP_HEADER_MIN_HEIGHT = 76;
export const GROUP_HEADER_MAX_WIDTH = 420;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function visibleEntityLabel(entity = {}) {
  return String(entity.ownerLabel || entity.label || "Элемент").trim();
}

export function visibleEntityPurpose(entity = {}) {
  return String(entity.ownerPurpose || entity.purpose || entity.path || "").trim();
}

export function estimateTextWidth(text, fontSize = 15) {
  let units = 0;
  for (const character of String(text || "")) {
    if (/\s/u.test(character)) units += .34;
    else if (/[MWШЩЖФЮ@%]/u.test(character)) units += .86;
    else if (/[A-ZА-ЯЁ0-9]/u.test(character)) units += .68;
    else if (/[.,:;!|()\[\]{}'"`-]/u.test(character)) units += .35;
    else units += .56;
  }
  return units * fontSize;
}

export function wrappedLineCount(text, availableWidth, fontSize = 15) {
  const width = Math.max(32, availableWidth);
  const words = String(text || "").trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1; let current = 0;
  for (const word of words) {
    const wordWidth = estimateTextWidth(word, fontSize);
    if (wordWidth > width) {
      const chunks = Math.ceil(wordWidth / width);
      if (current > 0) { lines += 1; current = 0; }
      lines += chunks - 1;
      current = wordWidth - (chunks - 1) * width;
      continue;
    }
    const gap = current > 0 ? estimateTextWidth(" ", fontSize) : 0;
    if (current > 0 && current + gap + wordWidth > width) { lines += 1; current = wordWidth; }
    else current += gap + wordWidth;
  }
  return lines;
}

export function entityCardSize(entity = {}, widthHint) {
  const title = visibleEntityLabel(entity);
  const naturalWidth = estimateTextWidth(title, 20) + 64;
  const width = widthHint || Math.ceil(clamp(naturalWidth, ENTITY_MIN_WIDTH, ENTITY_MAX_WIDTH));
  const titleLines = Math.min(3, wrappedLineCount(title, width - 76, 20));
  const purposeLines = Math.min(2, wrappedLineCount(visibleEntityPurpose(entity), width - 40, 14));
  const statusHeight = entity.status && !["operational", "existing", "implemented", "verified"].includes(entity.status) ? 22 : 0;
  const height = Math.max(ENTITY_BASE_HEIGHT, 28 + titleLines * ENTITY_TITLE_LINE_HEIGHT + 8 + purposeLines * 19 + Math.max(16,statusHeight));
  return { width, height, titleLines, purposeLines };
}

export function groupHeaderSize(entity = {}, widthHint = 360) {
  const width = Math.ceil(clamp(widthHint, 280, GROUP_HEADER_MAX_WIDTH));
  const titleLines = wrappedLineCount(visibleEntityLabel(entity), width - 64, 18);
  const purposeLines = 0;
  const height = Math.max(76, 28 + titleLines * 23);
  return { width, height, titleLines, purposeLines };
}
